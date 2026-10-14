import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from '../lib/config.mjs';
import { usd } from '../../utils/numbers.mjs';
import { readJson } from '../../utils/files.mjs';
import { validIpa, validRespelling, validateIpaRecord, choosePair, languagePolicy, validateOrderedRecords, REVIEW_OUTPUT_SCHEMA, RESPELL_REVIEW_OUTPUT_SCHEMA, validateRespellingRecord } from '../lib/data.mjs';
import { createAI } from '../lib/ai.mjs';
import { BudgetReachedError, usageCost, reservation, outputText, retryDelay } from '../../utils/ai-gateway.mjs';
import { populate } from '../lib/run.mjs';

const databaseSettings = { TURSO_DATABASE_URL: 'libsql://test.turso.io', TURSO_AUTH_TOKEN: 'fake-database-token' };
const languages = [
  { id: 'en-id', language_code: 'en', name: 'English', hasEntries: true },
  { id: 'es-id', language_code: 'es', name: 'Spanish', hasEntries: true },
];
const source = languagePolicy(languages[0]);
const target = languagePolicy(languages[1]);

const temporaryDirectories = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(extra = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'sapo-phonetics-'));
  temporaryDirectories.push(stateDir);
  const cfg = { ...configured(['--budget', '10'], {
    CLOUDFLARE_API_TOKEN: 'fake-gateway-token',
  }, { cloudflare: { accountId: 'a'.repeat(32), gatewayId: 'test' } }), stateDir, ...extra };
  return cfg;
}

const gatewaySettings = { accountId: 'a'.repeat(32), gatewayId: 'test' };
function configured(argv = [], env = {}, settings = {}) {
  return configuration('transcriptions', argv, { ...databaseSettings, CLOUDFLARE_API_TOKEN: 'fake-gateway-token', ...env },
    () => typeof settings === 'string' ? settings : JSON.stringify({ ...settings,
      cloudflare: { ...gatewaySettings, ...settings.cloudflare }, limits: { maxUsd: '10', ...settings.limits } }));
}

function assertNoCredentials(cfg, directory = cfg.stateDir) {
  for (const file of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, file.name);
    if (file.isDirectory()) assertNoCredentials(cfg, path);
    else {
      const text = readFileSync(path, 'utf8');
      assert.equal(text.includes('fake-openai-key'), false, `OpenAI key leaked to ${file.name}`);
      assert.equal(text.includes(cfg.token), false, `Gateway token leaked to ${file.name}`);
      assert.equal(text.includes(cfg.databaseToken), false, `Database token leaked to ${file.name}`);
    }
  }
}

function answer(records, extra = {}) {
  return { id: 'response-1', status: 'completed', service_tier: 'default',
    usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1000, cache_write_tokens: 100 },
      output_tokens: 500, output_tokens_details: { reasoning_tokens: 400 } },
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ records }) }] }], ...extra };
}

const row = (key, value = '/həˈloʊ/') => ({ key, status: 'ready', value, note: '' });
const modelRow = (job, value = '/həˈloʊ/') => ({ index: job.index, word: job.word, status: 'ready', value, note: '' });

const modelRespellingRow = (job, respelling = 'jelóu') => ({ index: job.index, word: job.word,
  transcription: job.transcription ?? '/həˈloʊ/', transcriptionStatus: 'ready',
  respelling, respellingStatus: 'ready', note: '' });
const flagReview = (record, note) => Object.hasOwn(record, 'respelling') ?
  { ...record, respellingStatus: 'review', respelling: null, note } :
  { ...record, status: 'review', value: null, note };

function fakeFetch(counter, transform) {
  return async (url, options) => {
    counter.calls++;
    assert.equal(url, `https://gateway.ai.cloudflare.com/v1/${'a'.repeat(32)}/test/openai/responses`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['cf-aig-max-attempts'], '1');
    assert.equal(new Headers(options.headers).has('authorization'), false);
    assert.equal(options.headers['cf-aig-authorization'], 'Bearer fake-gateway-token');
    assert.equal(options.headers['cf-aig-no-wholesale'], 'true');
    assert.equal(options.headers['cf-aig-gateway-id'], undefined);
    const body = JSON.parse(options.body);
    assert.deepEqual(body.reasoning, { effort: 'high' });
    assert.equal(body.model, 'gpt-6.1-sol');
    assert.equal(body.temperature, undefined);
    const input = JSON.parse(body.input[1].content);
    const policy = input.target ?? (input.words.some((job) => job.note !== undefined) &&
      JSON.parse(body.input[0].content[0].text.split('Language policies (data):\n')[1]).target);
    const records = input.words.map((job) => policy ? modelRespellingRow(job) : modelRow(job));
    return new Response(JSON.stringify(transform ? transform(records) : answer(records)), { status: 200 });
  };
}

function fakeDatabase(entries) {
  const calls = { reads: 0, refreshes: 0, ipa: 0, respell: 0 };
  let next = 1;
  const hydrate = (entry, targetLanguageId) => ({ ...structuredClone(entry),
    transcriptions: entry.transcriptions.map((ipa) => ({ ...ipa,
      hasRespelling: (ipa.targets ?? []).includes(languages.find((l) => l.id === targetLanguageId)?.language_code) })),
  });
  const compare = (a, b) => a.orthographic_form < b.orthographic_form ? -1 :
    a.orthographic_form > b.orthographic_form ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const db = {
    calls, entries,
    languages: async () => languages.map((language) => ({ ...language,
      hasEntries: entries.some((entry) => entry.language_code === language.language_code) })),
    pendingEntries: async ({ languageId, after, targetLanguageId, limit }) => {
      calls.reads++;
      return entries.filter((e) => e.language_id === languageId &&
        (!after || compare(e, { orthographic_form: after[0], id: after[1] }) > 0))
        .sort(compare).map((e) => hydrate(e, targetLanguageId))
        .filter((e) => !e.transcriptions.length || (targetLanguageId && e.transcriptions.some((t) => !t.hasRespelling)))
        .slice(0, limit);
    },
    refreshEntries: async (selected, targetLanguageId) => {
      calls.refreshes++;
      return selected.map((entry) => hydrate(entries.find((e) => e.id === entry.id), targetLanguageId));
    },
    insertTranscriptions: async (rows) => {
      calls.ipa++;
      for (const row of rows) {
        const entry = entries.find((e) => e.id === row.entry_id);
        if (!entry.transcriptions.length) entry.transcriptions.push({ id: `ipa-${next++}`, transcription: row.transcription, targets: [] });
      }
    },
    insertRespellings: async (rows) => {
      calls.respell++;
      for (const row of rows) {
        const ipa = entries.flatMap((e) => e.transcriptions).find((t) => t.id === row.phonetic_transcription_id);
        assert.ok(ipa, 'Respelling must reference a real IPA database ID');
        if (!ipa.targets.includes(row.target_language_code)) ipa.targets.push(row.target_language_code);
      }
    },
  };
  return db;
}

const entry = (id, code = 'en', transcriptions = []) => ({ id, language_id: `${code}-id`,
  language_code: code, orthographic_form: `word-${id}`, transcriptions });

test('configuration generates by default and custom models require explicit prices', () => {
  const cfg = configured();
  assert.equal(Object.hasOwn(cfg, 'generate'), false);
  assert.equal(cfg.write, false);
  assert.equal(cfg.budget, 10e9);
  assert.equal(cfg.batchSizeMultiplicity, 1);
  assert.equal(configured(['--write']).write, true);
  assert.throws(() => configured(['--generate']), /Unknown option/);
  assert.throws(() => configured(['--rescan']), /Unknown option/);
  assert.throws(() => configured(['--provider', 'anthropic']));
  assert.throws(() => configured(['--batch-size', '0']));
  assert.throws(() => configured(['--prod']));
  assert.throws(() => configured(['--model', 'openai/gpt-6.1-sol']), /native OpenAI/);
  assert.equal(usd('0.123456789'), 123456789);
  assert.throws(() => usd('-1'));
  assert.equal(configured([], {}, { ai: { pricesUsdPerMillion: { input: '1.001' } } }).prices.input, 1001);
  assert.throws(() => configured([], {}, { ai: { reasoningEffort: 'none' } }));
  assert.throws(() => languagePolicy(languages[0], { en: { code: 'es' } }));
  assert.throws(() => languagePolicy(languages[0], { en: { script: 'invalid-script' } }));
});

test('both scripts allow CLI and YAML batch sizes through 1000 and reject larger values', () => {
  for (const task of ['transcriptions', 'respellings']) {
    const config = (args, settings = {}) => configuration(task, args, { ...databaseSettings, CLOUDFLARE_API_TOKEN: 'fake' },
      () => JSON.stringify({ ...settings, cloudflare: gatewaySettings, limits: { maxUsd: '1' } }));
    for (const batchSize of [1, 50, 51, 1000]) {
      assert.equal(config(['--batch-size', String(batchSize)]).batchSize, batchSize);
      assert.equal(config([], { batchSize }).batchSize, batchSize);
    }
    for (const batchSize of [0, 1001, 1.5]) {
      assert.throws(() => config(['--batch-size', String(batchSize)]), /1 to 1000/);
      assert.throws(() => config([], { batchSize }));
    }
  }
});

test('batch size multiplicity defaults to 1 and accepts only explicit safe integers greater than 1', () => {
  for (const task of ['transcriptions', 'respellings']) {
    const config = (args, settings = {}) => configuration(task, args, { ...databaseSettings, CLOUDFLARE_API_TOKEN: 'fake' },
      () => JSON.stringify({ ...settings, cloudflare: gatewaySettings, limits: { maxUsd: '1' } }));
    assert.equal(config([]).batchSizeMultiplicity, 1);
    assert.equal(config([], { batchSizeMultiplicity: 3 }).batchSizeMultiplicity, 3);
    assert.equal(config(['--batch-size-multiplicity', '2'], { batchSizeMultiplicity: 3 }).batchSizeMultiplicity, 2);
    for (const value of ['', ' ', '0', '1', '-1', '1.5', '2.5', 'NaN', 'Infinity', 'no', '9007199254740992']) {
      assert.throws(() => config([`--batch-size-multiplicity=${value}`]), /batch size multiplicity/);
    }
    for (const value of [0, 1, -1, 1.5, 2.5, true, null, '2', [], {}, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => config([], { batchSizeMultiplicity: value }));
    }
    for (const batchSize of [1, 3, 20, 1000]) {
      const largest = Math.floor(Number.MAX_SAFE_INTEGER / batchSize);
      assert.equal(config([], { batchSize, batchSizeMultiplicity: largest }).batchSizeMultiplicity, largest);
      assert.throws(() => config([], { batchSize, batchSizeMultiplicity: largest + 1 }));
      assert.throws(() => config(['--batch-size-multiplicity', String(largest + 1)], { batchSize }));
    }
    assert.throws(() => config(['--max-rows', '20']), /Unknown option/);
    assert.throws(() => config([], { maxRows: 20 }), /Unknown setting/);
    assert.throws(() => config(['--max-pages', '1']), /Unknown option/);
    assert.throws(() => config([], { maxPages: 1 }), /Unknown setting/);
  }
});

test('YAML settings, CLI overrides, and credential-only environment variables', () => {
  const cfg = configured(['--budget', '0.123456789', '--batch-size', '5', '--batch-size-multiplicity', '2'], {
    ...databaseSettings, CLOUDFLARE_API_TOKEN: 'fake', OPENAI_API_KEY: 'fake-openai-key',
    AI_PROVIDER: 'ignored', AI_MODEL: 'ignored', AI_API: 'ignored', AI_REASONING_EFFORT: 'none',
    AI_INPUT_USD_PER_M: '999', SAPO_MAX_USD: '999', AI_MAX_OUTPUT_TOKENS: '1',
    AI_REQUESTS_PER_MINUTE: '999', AI_TOKENS_PER_MINUTE: '1', AI_MAX_ATTEMPTS: '999', AI_TIMEOUT_MS: '1',
    CLOUDFLARE_ACCOUNT_ID: 'ignored', CLOUDFLARE_AI_GATEWAY_ID: 'ignored', SAPO_LANGUAGE_POLICY_FILE: '/ignored',
  }, `
batchSize: 10
batchSizeMultiplicity: 3
ai:
  provider: openai
  model: gpt-6.1-sol
  api: responses
  reasoningEffort: low
  maxOutputTokens: 1000
  pricesUsdPerMillion:
    input: "1.001"
    cachedInput: "0.1"
    cacheWrite: "2.5"
    output: "10"
limits:
  maxUsd: "0.5"
  requestsPerMinute: 2
  tokensPerMinute: 10000
  maxAttempts: 2
  timeoutMs: 5000
cloudflare:
  accountId: "${'a'.repeat(32)}"
  gatewayId: test
languagePolicies:
  es:
    dialect: Castilian Spanish
    script: Latin
`);
  assert.equal(cfg.budget, 123456789);
  assert.equal(cfg.batchSize, 5);
  assert.equal(cfg.batchSizeMultiplicity, 2);
  assert.equal(cfg.model, 'gpt-6.1-sol');
  assert.equal(cfg.provider, 'openai');
  assert.equal(cfg.api, 'responses');
  assert.equal(cfg.effort, 'low');
  assert.equal(cfg.outputTokens, 1000);
  assert.equal(cfg.rpm, 2);
  assert.equal(cfg.tpm, 10000);
  assert.equal(cfg.attempts, 2);
  assert.equal(cfg.timeout, 5000);
  assert.equal(cfg.prices.input, 1001);
  assert.equal(cfg.account, 'a'.repeat(32));
  assert.equal(cfg.gateway, 'test');
  assert.equal(cfg.token, 'fake');
  assert.equal(cfg.openaiKey, undefined);
  assert.equal(cfg.databaseUrl, 'https://test.turso.io');
  assert.equal(cfg.databaseToken, 'fake-database-token');
  assert.equal(Object.hasOwn(cfg, 'generate'), false);
  assert.equal(cfg.write, false);
  assert.equal(languagePolicy(languages[1], cfg.languagePolicies).dialect, 'Castilian Spanish');
});

test('YAML rejects unknown settings, invalid types, invalid policies, and unsafe limits', () => {
  for (const settings of [
    { generate: true }, { write: true }, { project: '/checkout' }, { token: 'secret' }, { cloudflare: { apiToken: 'secret' } },
    { ai: { apiKey: 'secret' } }, { openaiKey: 'secret' },
    { ai: { modle: 'typo' } }, { limits: { maxUsd: 1 } }, { ai: { pricesUsdPerMillion: { input: 2 } } },
    { batchSize: true }, { batchSize: null }, { batchSize: 1.5 }, { batchSize: 0 },
    { ai: [] }, { ai: { model: '' } }, { ai: { api: 'invalid' } },
    { ai: { maxOutputTokens: 0 } }, { limits: { requestsPerMinute: 0 } },
    { limits: { tokensPerMinute: 1 } }, { limits: { maxAttempts: 6 } }, { limits: { timeoutMs: 1 } },
    { cloudflare: { accountId: 'wrong' } }, { cloudflare: { gatewayId: 'invalid/path' } },
    { languagePolicies: [] }, { languagePolicies: { es: { code: 'en' } } },
    { languagePolicies: { es: { script: 'invalid-script' } } },
    { languagePolicies: { es: { dialect: 'bad\npolicy' } } },
  ]) assert.throws(() => configured([], {}, settings), JSON.stringify(settings));
  for (const text of ['', 'null', '[]', 'ai: [']) assert.throws(() => configured([], {}, text));
  assert.throws(() => configured([], {}, 'batchSize: .nan'));
  assert.throws(() => configured(['--budget', '1'], { ...databaseSettings, CLOUDFLARE_API_TOKEN: undefined }), /Cloudflare/);
  assert.throws(() => configured([], {}, { limits: { maxUsd: '0' } }), /positive/);
});

test('alternate YAML models require complete prices and cannot reuse another model price table', () => {
  const ai = { provider: 'openai', model: 'test-model', api: 'chat', reasoningEffort: 'omit',
    pricesUsdPerMillion: { input: '1', cachedInput: '1', cacheWrite: '1', output: '2' } };
  assert.equal(configured([], {}, { ai }).api, 'chat');
  for (const name of Object.keys(ai.pricesUsdPerMillion)) {
    const prices = { ...ai.pricesUsdPerMillion };
    delete prices[name];
    assert.throws(() => configured([], {}, { ai: { ...ai, pricesUsdPerMillion: prices } }), /four explicit/);
  }
  assert.throws(() => configured(['--model', 'different-model'], {}, { ai }), /does not match/);
  assert.throws(() => configured(['--provider', 'other'], {}, { ai }), /only openai/);
});

test('Bun only loads explicitly selected environment files, even with NODE_ENV=production', () => {
  const cfg = fixture();
  writeFileSync(join(cfg.stateDir, 'bunfig.toml'), readFileSync(new URL('../../../bunfig.toml', import.meta.url)));
  writeFileSync(join(cfg.stateDir, '.env'), 'SAPO_BUN_ENV_TEST=explicit\n');
  writeFileSync(join(cfg.stateDir, '.env.production'), 'SAPO_BUN_ENV_TEST=production\n');
  writeFileSync(join(cfg.stateDir, '.env.local'), 'SAPO_BUN_ENV_TEST=local\n');
  const env = { ...process.env, NODE_ENV: 'production' };
  delete env.SAPO_BUN_ENV_TEST;
  const code = 'console.log(process.env.SAPO_BUN_ENV_TEST ?? "unset")';
  const run = (args) => {
    const result = Bun.spawnSync({ cmd: [process.execPath, ...args, '-e', code], cwd: cfg.stateDir, env });
    assert.equal(result.exitCode, 0, result.stderr.toString());
    return result.stdout.toString().trim();
  };
  assert.equal(run([]), 'unset');
  assert.equal(run(['--env-file=.env']), 'explicit');
});

test('exact integer costs include cache writes and do not double count reasoning', () => {
  const cost = usageCost(answer([]), { input: 2000, cached: 100, write: 2500, output: 10000 }, 'responses', true);
  assert.equal(cost.cost, 7150000); // 900 uncached + 1000 cached + 100 writes + 500 output
  assert.equal(cost.reasoning, 400);
  assert.throws(() => usageCost({ usage: { input_tokens: 1, output_tokens: 1 } }, {}, 'responses', true));
  assert.throws(() => usageCost(answer([], { service_tier: 'ultrafast' }), {}, 'responses'));
  assert.throws(() => usageCost(answer([], { usage: { input_tokens: 1, output_tokens: 0,
    input_tokens_details: { cached_tokens: 2 } } }), {}, 'responses'));
  const chat = usageCost({ usage: { prompt_tokens: 100, completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 30 } } },
  { input: 2000, cached: 100, write: 2500, output: 10000 }, 'chat');
  assert.equal(chat.cost, 662000);
});

test('record validation rejects invalid review states, IPA, and target scripts', () => {
  assert.throws(() => validateIpaRecord({ ...row('1'), status: 'review', value: '/a/', note: 'uncertain' }));
  assert.throws(() => validateIpaRecord({ ...row('1'), note: 'extra explanation' }));
  assert.throws(() => validateIpaRecord({ ...row('1'), status: 'unknown' }));
  assert.throws(() => validateIpaRecord(row('1', 'not IPA')));
  assert.ok(validIpa('/həˈloʊ/'));
  assert.ok(validIpa('/ni˧˥/'));
  assert.equal(validIpa('/你好/'), false);
  assert.equal(validIpa('/a1/'), false);
  assert.ok(validRespelling('jelóu', target));
  assert.equal(validRespelling('həˈloʊ', target), false);
  assert.equal(validRespelling('こんにちは', target), false);
  assert.ok(validRespelling('ハロー', { code: 'ja', script: 'Japanese' }));
  assert.ok(validRespelling('你好', { code: 'zh', script: 'Han' }));
  assert.equal(validRespelling('ni hao', { code: 'zh', script: 'Han' }), false);
});

test('random pair has a populated source and distinct target; duplicate codes fail', () => {
  const pair = choosePair([{ ...languages[0], hasEntries: false }, languages[1]], () => 0);
  assert.equal(pair.source.language_code, 'es');
  assert.equal(pair.target.language_code, 'en');
  assert.throws(() => choosePair([languages[0]], () => 0));
  assert.throws(() => choosePair([languages[0], languages[0]], () => 0));
  const completed = new Map([['en', new Set(['es'])]]);
  assert.equal(choosePair(languages, () => 0, completed).source.language_code, 'es');
  completed.set('es', new Set(['en']));
  assert.equal(choosePair(languages, () => 0, completed), null);
});

test('a refused/incomplete response cannot become a database result', () => {
  assert.throws(() => outputText(answer([], { status: 'incomplete' }), 'responses'));
  assert.throws(() => outputText(answer([], { output: [{ type: 'message', content: [{ type: 'refusal' }] }] }), 'responses'));
  assert.throws(() => outputText({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }, 'chat'));
  assert.equal(retryDelay('2', 0, 0), 2250);
  assert.equal(retryDelay('Thu, 01 Jan 1970 00:00:10 GMT', 0, 0), 10250);
});

test('a batch can start below budget even when its reservation exceeds the remaining budget', async () => {
  const cfg = fixture({ budget: 1 });
  const count = { calls: 0 };
  const ai = createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} });
  assert.equal((await ai.generate('ipa', [{ key: '1', word: 'hello' }], source)).get('1').status, 'ready');
  assert.equal(count.calls, 1);
  assert.equal(ai.totals().committed, 7150000);
});

test('successful output is cached per item and billed once across restart and batch-size changes', async () => {
  const cfg = fixture();
  const count = { calls: 0 };
  const jobs = [{ key: '1', word: 'hello' }, { key: '2', word: 'hello' }];
  let ai = createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} });
  await ai.generate('ipa', jobs, source);
  assert.equal(count.calls, 1);
  assert.equal(ai.totals().known, 7150000);
  assert.equal(ai.totals().uncertain, 0);
  ai = createAI({ ...cfg, batchSize: 1 }, { fetchFn: fakeFetch(count), log: () => {} });
  await ai.generate('ipa', jobs, source);
  assert.equal(count.calls, 1);
  assert.equal(ai.totals().committed, 0);
  const saved = readJson(join(cfg.stateDir, 'results', readdirSync(join(cfg.stateDir, 'results'))[0]));
  assert.ok(saved.job.word);
  assert.equal(saved.source, 'en');
  assertNoCredentials(cfg);
});

test('429 retries honor Retry-After, record uncertain cost, and settle the next attempt', async () => {
  const cfg = fixture({ budget: 1 });
  const count = { calls: 0 };
  const success = fakeFetch(count);
  let rejected = false;
  const delays = [];
  const ai = createAI(cfg, { fetchFn: async (...args) => {
    if (!rejected) { rejected = true; return new Response('{}', { status: 429, headers: { 'retry-after': '2' } }); }
    return success(...args);
  }, wait: async (ms) => delays.push(ms), log: () => {} });
  await ai.generate('ipa', [{ key: '1', word: 'hello' }], source);
  assert.ok(delays.includes(2250));
  assert.equal(count.calls, 1);
  assert.ok(ai.totals().uncertain > 0);
  assert.equal(ai.totals().known, 7150000);
});

test('alternate OpenAI chat models use the provider-native gateway and settle usage', async () => {
  const cfg = fixture({ model: 'test-model', builtIn: false,
    api: 'chat', effort: 'omit', prices: { input: 1000, cached: 1000, write: 1000, output: 2000 } });
  let calls = 0;
  const ai = createAI(cfg, { fetchFn: async (url, options) => {
    calls++;
    assert.equal(url, `https://gateway.ai.cloudflare.com/v1/${cfg.account}/${cfg.gateway}/openai/chat/completions`);
    assert.equal(options.redirect, 'error');
    assert.equal(new Headers(options.headers).has('authorization'), false);
    assert.equal(options.headers['cf-aig-authorization'], `Bearer ${cfg.token}`);
    assert.equal(options.headers['cf-aig-no-wholesale'], 'true');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'test-model');
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.response_format.json_schema.strict, true);
    const input = JSON.parse(body.messages[1].content);
    return new Response(JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ records: input.words.map((j) => modelRow(j)) }) } }] }));
  }, log: () => {} });
  await ai.generate('ipa', [{ key: '1', word: 'hello' }], source);
  assert.equal(calls, 1);
  assert.equal(ai.totals().known, 200000);
  assertNoCredentials(cfg);
});

test('stored-key failures and redirects never fall back or persist echoed credentials', async () => {
  for (const status of [400, 401, 403, 302]) {
    const cfg = fixture();
    let calls = 0;
    const logs = [];
    const ai = createAI(cfg, { log: (text) => logs.push(text), fetchFn: async (url, options) => {
      calls++;
      assert.equal(url, `https://gateway.ai.cloudflare.com/v1/${cfg.account}/${cfg.gateway}/openai/responses`);
      assert.equal(options.redirect, 'error');
      assert.equal(new Headers(options.headers).has('authorization'), false);
      assert.equal(options.headers['cf-aig-no-wholesale'], 'true');
      return new Response(JSON.stringify({
        error: { message: `Invalid credentials: fake-openai-key ${cfg.token}` },
        ...(status === 401 ? { usage: answer([]).usage, service_tier: 'default' } : {}),
      }), { status, headers: { Location: 'https://api.openai.com/v1/responses' } });
    } });
    await assert.rejects(ai.generate('ipa', [{ key: '1', word: 'hello' }], source), new RegExp(`HTTP ${status}`));
    assert.equal(calls, 1);
    assert.equal(ai.totals().known, status === 401 ? 7150000 : 0);
    assertNoCredentials(cfg);
    assert.equal(logs.join().includes('fake-openai-key'), false);
    assert.equal(logs.join().includes(cfg.token), false);
  }
});

test('both APIs generate ordered words without exposing database keys or hashes', async () => {
  for (const api of ['responses', 'chat']) {
    const cfg = fixture({ api });
    const jobs = [{ key: 'opaque-id-1', word: 'hello', transcription: '/a/' }, { key: 'opaque-id-2', word: 'hello', transcription: '/b/' }];
    let calls = 0;
    const ai = createAI(cfg, { log: () => {}, fetchFn: async (url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      const input = JSON.parse(api === 'responses' ? body.input[1].content : body.messages[1].content);
      assert.deepEqual(input.words, [{ index: 0, word: 'hello', transcription: '/a/' }, { index: 1, word: 'hello', transcription: '/b/' }]);
      assert.equal(JSON.stringify(body).includes('opaque-id'), false);
      const records = input.words.map((job) => modelRespellingRow(job));
      if (api === 'responses') return Response.json(answer(records));
      return Response.json({ usage: { prompt_tokens: 2000, completion_tokens: 500,
        prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 100 } },
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ records }) } }] });
    } });
    const results = await ai.generate('respell', jobs, source, target);
    assert.equal(calls, 1);
    assert.deepEqual([...results].map(([key, record]) => [key, record.respelling]), jobs.map((job) => [job.key, 'jelóu']));
  }
});

test('ordered validation rejects shifts, spelling normalization and invalid values per item', () => {
  const jobs = [{ key: '1', word: 'é' }, { key: '2', word: 'hello' }];
  const rows = jobs.map((j, index) => modelRow({ ...j, index }));
  for (const bad of [{ ...rows[0], word: 'é' }, { ...rows[0], index: 1 }, { ...rows[0], value: 'bad' }]) {
    const result = validateOrderedRecords({ records: [bad, rows[1]] }, jobs, 'ipa');
    assert.deepEqual(result.records.map((r) => r.key), ['2']);
    assert.equal(result.rejected[0].job.key, '1');
  }
  for (const records of [rows.slice(1), [...rows, rows[0]], [...rows].reverse()]) {
    const result = validateOrderedRecords({ records }, jobs, 'ipa');
    assert.equal(result.records.length, 0);
    assert.equal(result.rejected.length, 2);
  }
  const repeated = [{ key: 'a', word: 'read', transcription: '/riːd/' }, { key: 'b', word: 'read', transcription: '/rɛd/' }];
  const result = validateOrderedRecords({ records: repeated.map((j, index) => modelRespellingRow({ ...j, index }, index ? 'red' : 'rid')) }, repeated, 'respell', target);
  assert.deepEqual(result.records.map((r) => [r.key, r.respelling]), [['a', 'rid'], ['b', 'red']]);
});

test('missing usage stops before result caching', async () => {
  const cfg = fixture();
  const count = { calls: 0 };
  const ai = createAI(cfg, { fetchFn: fakeFetch(count, (rows) => answer(rows, { usage: undefined })), log: () => {} });
  await assert.rejects(ai.generate('ipa', [{ key: '1', word: 'hello' }], source), /Missing usage/);
  assert.ok(ai.totals().uncertain > 0);

});

test('IPA population visits all languages in random order and preserves existing variants', async () => {
  for (const write of [false, true]) {
    const cfg = fixture({ write });
    const db = fakeDatabase([entry('1'), entry('2', 'en', [{ id: 'old', transcription: '/old/', targets: [] }]), entry('3', 'es')]);
    const count = { calls: 0 }, requests = [], bounds = [];
    const fetcher = fakeFetch(count);
    const dependencies = { log: () => {}, fetchFn: (url, options) => {
      requests.push(JSON.parse(JSON.parse(options.body).input[1].content).source.code);
      return fetcher(url, options);
    } };
    await populate('transcriptions', cfg, db, createAI(cfg, dependencies), {
      log: () => {}, select: (n) => { bounds.push(n); return n - 1; },
    });
    assert.deepEqual(bounds, [2, 1]);
    assert.deepEqual(requests, ['es', 'en']);
    assert.equal(db.entries[1].transcriptions[0].transcription, '/old/');
    assert.equal(count.calls, 2);
    if (write) assert.ok(db.entries.every((e) => e.transcriptions.length === 1));
    await populate('transcriptions', cfg, db, createAI(cfg, {
      log: () => {}, fetchFn: () => { throw new Error('Unexpected repeat generation'); },
    }), { log: () => {}, select: () => 0 });
    assert.equal(count.calls, 2);
    assert.equal(db.entries[1].transcriptions.length, 1);
  }
});

test('both scripts finalize reviews before writing and skip inserted results on restart', async () => {
  for (const task of ['transcriptions', 'respellings']) {
    const cfg = fixture({ write: true, batchSize: 1, batchSizeMultiplicity: 2, rpm: 1000, tpm: 1e9 });
    const db = fakeDatabase([entry('1'), entry('2')]);
    const count = { calls: 0 };
    const ai = createAI(cfg, { fetchFn: fakeFetch(count, (rows) => answer(rows.map((r) => count.calls % 2 ?
      flagReview(r, 'Ambiguous without context') : r))), log: () => {} });
    await populate(task, cfg, db, ai, { select: () => 0, log: () => {} });
    assert.ok(db.entries.every((e) => e.transcriptions.length === 1));
    if (task === 'respellings') assert.ok(db.entries.every((e) => e.transcriptions[0].targets.includes('es')));
    const before = count.calls;
    assert.equal(before, 4);
    const resumed = createAI(cfg, { fetchFn: () => { throw new Error('Unexpected repeat generation'); }, log: () => {} });
    await populate(task, cfg, db, resumed, { select: () => 0, log: () => {} });
    assert.equal(count.calls, before);
  }
});

test('both APIs review only flagged words and notes with the same model and a different definitive prompt', async () => {
  for (const api of ['responses', 'chat']) {
    for (const task of ['ipa', 'respell']) {
      const cfg = fixture({ api });
      const requests = [];
      const jobs = [{ key: 'local-1', word: 'read' }, { key: 'local-2', word: 'hello' }, { key: 'local-3', word: 'read' }]
        .map((job, index) => ({ ...job, ...(task === 'respell' ? { transcription: index ? '/rɛd/' : '/riːd/' } : {}) }));
      const ai = createAI(cfg, { log: () => {}, fetchFn: async (url, options) => {
        const body = JSON.parse(options.body);
        requests.push(body);
        const input = JSON.parse(api === 'responses' ? body.input[1].content : body.messages[1].content);
        const records = input.words.map((job, index) => requests.length === 1 && index !== 1 ?
          flagReview(task === 'ipa' ? modelRow(job) : modelRespellingRow(job, 'rid'), `Resolve variant ${index}`) :
          task === 'ipa' ? modelRow(job, '/riːd/') : modelRespellingRow(job, 'rid'));
        return new Response(JSON.stringify(api === 'responses' ? answer(records) : {
          id: 'chat-answer', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ records }) } }],
          usage: { prompt_tokens: 2000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 100 } },
        }));
      } });
      const result = await ai.generate(task, jobs, source, task === 'respell' ? target : null);
      assert.equal(requests.length, 2);
      const [first, second] = requests;
      assert.equal(second.model, first.model);
      const prompt = (body) => api === 'responses' ? body.input[0].content[0].text : body.messages[0].content;
      assert.notEqual(prompt(first), prompt(second));
      assert.equal(api === 'responses' ? second.input.length : second.messages.length, 2);
      assert.deepEqual(api === 'responses' ? second.text.format.schema : second.response_format.json_schema.schema,
        task === 'ipa' ? REVIEW_OUTPUT_SCHEMA : RESPELL_REVIEW_OUTPUT_SCHEMA);
      const input = JSON.parse(api === 'responses' ? second.input[1].content : second.messages[1].content);
      assert.deepEqual(Object.keys(input), ['words']);
      assert.deepEqual(input.words, [0, 2].map((original, index) => ({ index, word: 'read',
        ...(task === 'respell' ? { transcription: jobs[original].transcription } : {}), note: `Resolve variant ${original}`,
        ...(task === 'respell' ? { candidate: { transcription: jobs[original].transcription,
          transcriptionStatus: 'ready', respelling: null, respellingStatus: 'review' } } : {}) })));
      assert.equal(JSON.stringify(second).includes('hello'), false);
      assert.equal(JSON.stringify(second).includes('local-'), false);
      assert.equal(result.size, 3);
      assert.ok([...result.values()].every((record) => task === 'ipa' ? record.status === 'ready' :
        record.transcriptionStatus === 'ready' && record.respellingStatus === 'ready'));
      assert.equal(ai.totals().known, 2 * 7150000);
      const saved = readdirSync(join(cfg.stateDir, 'results')).map((file) => readJson(join(cfg.stateDir, 'results', file)));
      assert.equal(saved.length, 3);
      assert.ok(saved.every((item) => typeof (task === 'ipa' ? item.value : item.respelling) === 'string' && !Object.hasOwn(item, 'firstPassRecord')));
    }
  }
});

test('invalid IPA review output is skipped without database writes or cached candidates', async () => {
  const invalid = [
    (r) => (flagReview(r, 'Still unsure')),
    (r) => ({ ...r, value: null }),
    (r) => ({ ...r, value: 'not IPA' }),
    (r) => ({ ...r, word: 'wrong' }),
    (r) => ({ ...r, index: 1 }),
    (r) => ({ ...r, note: 'Explanation' }),
  ];
  for (const transform of invalid) {
    const cfg = fixture({ write: true });
    const db = fakeDatabase([entry('1')]);
    const count = { calls: 0 };
    const logs = [];
    const ai = createAI(cfg, { log: (text) => logs.push(text), fetchFn: fakeFetch(count, (rows) => answer(rows.map((r) =>
      count.calls === 1 ? flagReview(r, 'Ambiguous') : transform(r)))) });
    await populate('transcriptions', cfg, db, ai, { log: () => {} });
    assert.equal(db.calls.ipa, 0);
    assert.deepEqual(readdirSync(cfg.stateDir), []);
    assert.equal(count.calls, 2);
    assert.ok(logs.some((text) => text.includes('ipa review: skipped "word-1"')));
  }
});

test('IPA review saves valid siblings, continues to later batches and retries only skipped words', async () => {
  for (const api of ['responses', 'chat']) for (const write of [false, true]) {
    const cfg = fixture({ api, write, batchSize: 3, batchSizeMultiplicity: 2 });
    const db = fakeDatabase([entry('1'), entry('2'), entry('3'), entry('4')]);
    const requests = [], logs = [];
    let retry = false;
    const dependencies = { log: (text) => logs.push(text), fetchFn: async (url, options) => {
      const body = JSON.parse(options.body);
      const input = JSON.parse(api === 'responses' ? body.input[1].content : body.messages[1].content);
      requests.push(input.words);
      const reviewing = input.words[0].note !== undefined;
      const records = input.words.map((job) => {
        const record = modelRow(job, '/a/');
        if (retry) return record;
        if (job.word === 'word-1') return { ...record, value: '/ḫ/' };
        if (job.word === 'word-3' && !reviewing) return flagReview(record, 'Ambiguous reading');
        return record;
      });
      return Response.json(api === 'responses' ? answer(records) : {
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ records }) } }],
        usage: { prompt_tokens: 2000, completion_tokens: 500,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
      });
    } };
    await populate('transcriptions', cfg, db, createAI(cfg, dependencies), { select: () => 0, log: () => {} });
    assert.deepEqual(requests.map((words) => words.map((job) => job.word)),
      [['word-1', 'word-2', 'word-3'], ['word-1', 'word-3'], ['word-4']]);
    assert.ok(logs.some((text) => text.includes('ipa review: skipped "word-1": Invalid ipa value')));
    assert.ok(logs.some((text) => text === 'ipa: 2 finalized (1 reviewed)'));
    assert.deepEqual(db.entries.map((e) => e.transcriptions.length), write ? [0, 1, 1, 1] : [0, 0, 0, 0]);
    if (write) assert.deepEqual(readdirSync(cfg.stateDir), []);
    else {
      const saved = readdirSync(join(cfg.stateDir, 'results')).map((file) => readJson(join(cfg.stateDir, 'results', file)));
      assert.deepEqual(saved.map((item) => item.job.word).sort(), ['word-2', 'word-3', 'word-4']);
      assert.ok(saved.every((item) => item.value === '/a/'));
    }
    retry = true;
    await populate('transcriptions', cfg, db, createAI(cfg, dependencies), { select: () => 0, log: () => {} });
    assert.equal(requests.length, 4);
    assert.deepEqual(requests[3].map((job) => job.word), ['word-1']);
    if (write) assert.ok(db.entries.every((e) => e.transcriptions.length === 1));
    else assert.equal(readdirSync(join(cfg.stateDir, 'results')).length, 4);
  }
});

test('1000-word batches use one full retrieval window and writes follow the configured batch size', async () => {
  for (const task of ['transcriptions', 'respellings']) {
    const cfg = fixture({ write: true, batchSize: 1000, batchSizeMultiplicity: 2, budget: 100e9, rpm: 1000, tpm: 1e9 });
    const db = fakeDatabase(Array.from({ length: 1001 }, (_, i) => entry(String(i))));
    const read = db.pendingEntries;
    const mutations = [db.insertTranscriptions, db.insertRespellings];
    db.pendingEntries = async (args) => { assert.equal(args.limit, 2000); return read(args); };
    [db.insertTranscriptions, db.insertRespellings] = mutations.map((insert) => async (rows) => {
      assert.ok(rows.length <= cfg.batchSize);
      return insert(rows);
    });
    const batches = [];
    const count = { calls: 0 };
    const fetcher = fakeFetch(count);
    const ai = createAI(cfg, { log: () => {}, fetchFn: (url, options) => {
      batches.push(JSON.parse(JSON.parse(options.body).input[1].content).words.length);
      return fetcher(url, options);
    } });
    await populate(task, cfg, db, ai, { select: () => 0, log: () => {} });
    assert.deepEqual(batches, [1000, 1]);
    assert.ok(db.entries.every((e) => e.transcriptions.length === 1));
    if (task === 'respellings') assert.ok(db.entries.every((e) => e.transcriptions[0].targets.includes('es')));
  }
});

test('long review notes are split to fit TPM reservations and every flagged item is finalized', async () => {
  const cfg = fixture({ batchSize: 1000, rpm: 1000, tpm: 100000, budget: 1 });
  const jobs = Array.from({ length: 200 }, (_, i) => ({ key: `key-${i}`, word: `word-${i}` }));
  let time = Date.now();
  const requests = [];
  const count = { calls: 0 };
  const fetcher = fakeFetch(count, (rows) => answer(rows.map((r) => count.calls === 1 ?
    { ...r, status: 'review', value: null, note: 'x'.repeat(500) } : r)));
  const ai = createAI(cfg, { log: () => {}, now: () => time, wait: async (ms) => { time += ms; },
    fetchFn: (url, options) => {
      const body = JSON.parse(options.body);
      assert.ok(reservation(body, cfg).tokens <= cfg.tpm);
      requests.push(JSON.parse(body.input[1].content).words);
      return fetcher(url, options);
    },
  });
  const result = await ai.generate('ipa', jobs, source);
  assert.equal(result.size, jobs.length);
  assert.ok([...result.values()].every((record) => record.status === 'ready'));
  assert.equal(requests[0].length, 200);
  assert.ok(requests.length > 2);
  assert.deepEqual(requests.slice(1).flat().map((job) => job.word), jobs.map((job) => job.word));
  assert.ok(requests.slice(1).flat().every((job) => job.note === 'x'.repeat(500)));
});


test('generation always requires gateway credentials and a positive per-run budget', () => {
  const read = () => JSON.stringify({ cloudflare: gatewaySettings, limits: { maxUsd: '1' } });
  assert.throws(() => configuration('transcriptions', [], {}, read), /Cloudflare/);
  assert.throws(() => configured([], {}, { cloudflare: { accountId: undefined } }), /Cloudflare/);
  assert.throws(() => configured(['--budget', '0']), /positive/);
  assert.throws(() => createAI(fixture({ token: undefined })), /CLOUDFLARE_API_TOKEN/);
  const cfg = configured([], { OPENAI_API_KEY: 'unused' });
  assert.equal(cfg.openaiKey, undefined);
  assert.equal(cfg.batchSizeMultiplicity, 1);
});

test('config paths are selected per script and resolve relative YAML paths', () => {
  const cfg = fixture();
  const path = join(cfg.stateDir, 'config.yml');
  writeFileSync(path, JSON.stringify({ stateDir: './results',
    cloudflare: gatewaySettings, limits: { maxUsd: '0.25' } }));
  const env = { ...databaseSettings, CLOUDFLARE_API_TOKEN: 'fake' };
  for (const task of ['transcriptions', 'respellings']) {
    const selected = configuration(task, ['--config', path], env);
    assert.equal(selected.stateDir, join(cfg.stateDir, 'results'));
    assert.equal(selected.budget, 250000000);
    const overridden = configuration(task, ['--config', path, '--state-dir', cfg.stateDir], env);
    assert.equal(overridden.stateDir, cfg.stateDir);
    const defaults = configuration(task, [], env, (file) => {
      assert.equal(file, new URL(`../config/${task}.yml`, import.meta.url).pathname);
      return JSON.stringify({ cloudflare: gatewaySettings, limits: { maxUsd: '1' } });
    });
    assert.equal(defaults.stateDir, new URL('../.state', import.meta.url).pathname);
  }
  assert.deepEqual(configuration('transcriptions', ['--help', '--config', '/missing'], {}), { help: true });
  assert.throws(() => configuration('unknown', [], env), /Unknown population task/);
});

function snapshot(directory) {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap((file) => {
    const path = join(directory, file.name);
    return file.isDirectory() ? Object.entries(snapshot(path)).map(([name, value]) => [`${file.name}/${name}`, value]) :
      [[file.name, readFileSync(path, 'utf8')]];
  }));
}

test('default mode saves only finalized values and reuses matching cached results', async () => {
  for (const task of ['transcriptions', 'respellings']) {
    const cfg = fixture();
    const db = fakeDatabase([entry('1')]);
    const count = { calls: 0 };
    const ai = createAI(cfg, { log: () => {}, fetchFn: fakeFetch(count, (rows) =>
      answer(rows.map((r) => count.calls % 2 ? flagReview(r, 'Ambiguous') : r))) });
    await populate(task, cfg, db, ai, { select: () => 0, log: () => {} });
    assert.equal(db.calls.ipa, 0);
    assert.equal(db.calls.respell, 0);
    assert.deepEqual(readdirSync(cfg.stateDir).sort(), ['results']);
    const files = readdirSync(join(cfg.stateDir, 'results'));
    assert.equal(files.length, 1);
    for (const file of files) {
      const item = readJson(join(cfg.stateDir, 'results', file));
      assert.deepEqual(Object.keys(item).sort(), item.task === 'ipa' ?
        ['job', 'signature', 'source', 'task', 'value'] : ['job', 'respelling', 'signature', 'source', 'target', 'task', 'transcription']);
      assert.equal(item.source, 'en');
      assert.equal(item.signature.length, 64);
      assert.equal(item.job.key.length > 0, true);
      assert.equal(item.job.word, 'word-1');
      assert.ok(typeof (item.task === 'ipa' ? item.value : item.respelling) === 'string');
    }
    assertNoCredentials(cfg);
    const before = snapshot(cfg.stateDir);
    await populate(task, cfg, db, createAI(cfg, { log: () => {}, fetchFn: () => { throw new Error('Cache must be reused'); } }),
      { select: () => 0, log: () => {} });
    assert.deepEqual(snapshot(cfg.stateDir), before);
  }
});

test('write mode creates no state directory for either script', async () => {
  for (const task of ['transcriptions', 'respellings']) {
    const root = fixture();
    const cfg = { ...root, write: true, stateDir: join(root.stateDir, 'absent') };
    const db = fakeDatabase([entry('1'), entry('2')]);
    const count = { calls: 0 };
    await populate(task, cfg, db, createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} }),
      { select: () => 0, log: () => {} });
    assert.deepEqual(readdirSync(root.stateDir), []);
    assert.ok(db.entries.every((e) => e.transcriptions.length === 1));
    if (task === 'respellings') assert.ok(db.entries.every((e) => e.transcriptions[0].targets.includes('es')));
  }
});

test('write mode reads matching local results without modifying any files', async () => {
  const cfg = fixture();
  const db = fakeDatabase([entry('1'), entry('2', 'en', [
    { id: 'old-1', transcription: '/a/', targets: ['es'] },
    { id: 'old-2', transcription: '/b/', targets: [] },
  ])]);
  const count = { calls: 0 };
  const options = { select: () => 0, log: () => {} };
  await populate('respellings', cfg, db, createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} }), options);
  assert.equal(count.calls, 1);
  const before = snapshot(cfg.stateDir);
  const writing = { ...cfg, write: true };
  const ai = createAI(writing, { log: () => {}, fetchFn: () => { throw new Error('No paid regeneration'); } });
  await populate('respellings', writing, db, ai, { log: () => {}, select: () => 0 });
  assert.equal(ai.totals().committed, 0);
  assert.ok(db.entries.flatMap((e) => e.transcriptions).every((ipa) => ipa.targets.includes('es')));
  assert.deepEqual(snapshot(cfg.stateDir), before);
});

test('each AI batch is reviewed and inserted before the next generation batch for both scripts', async () => {
  for (const task of ['transcriptions', 'respellings']) {
    const cfg = fixture({ write: true, batchSize: 1, batchSizeMultiplicity: 2 });
    const db = fakeDatabase([entry('1'), entry('2')].map((e, i) => task === 'respellings' ?
      { ...e, transcriptions: [{ id: `ipa-${i}`, transcription: '/a/', targets: [] }] } : e));
    const events = [];
    const field = task === 'transcriptions' ? 'insertTranscriptions' : 'insertRespellings';
    const insert = db[field];
    db[field] = async (rows) => { events.push('insert'); return insert(rows); };
    const count = { calls: 0 };
    const fetcher = fakeFetch(count, (rows) => answer(rows.map((r) => count.calls % 2 ?
      flagReview(r, 'Two readings') : r)));
    const ai = createAI(cfg, { log: () => {}, fetchFn: (url, options) => {
      const input = JSON.parse(JSON.parse(options.body).input[1].content);
      events.push(input.words[0].note ? 'review' : 'generate');
      return fetcher(url, options);
    } });
    await populate(task, cfg, db, ai, { select: () => 0, log: () => {} });
    assert.deepEqual(events, ['generate', 'review', 'insert', 'generate', 'review', 'insert']);
    assert.deepEqual(readdirSync(cfg.stateDir), []);
  }
});

test('earlier write batches survive an insertion failure and restart generates only missing data', async () => {
  const cfg = fixture({ write: true, batchSize: 1, batchSizeMultiplicity: 3 });
  const db = fakeDatabase([entry('1'), entry('2'), entry('3')]);
  const insert = db.insertTranscriptions;
  db.insertTranscriptions = async (rows) => {
    if (db.calls.ipa === 1) throw new Error('database unavailable');
    return insert(rows);
  };
  const count = { calls: 0 };
  await assert.rejects(populate('transcriptions', cfg, db,
    createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} }), { log: () => {} }), /database unavailable/);
  assert.equal(count.calls, 2);
  assert.equal(db.entries.filter((e) => e.transcriptions.length).length, 1);
  assert.deepEqual(readdirSync(cfg.stateDir), []);
  db.insertTranscriptions = insert;
  await populate('transcriptions', cfg, db, createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} }), { log: () => {} });
  assert.equal(count.calls, 4);
  assert.ok(db.entries.every((e) => e.transcriptions.length === 1));
});

test('each restart gets a fresh budget and discovers progress from the database or local cache', async () => {
  for (const write of [false, true]) {
    for (const task of ['transcriptions', 'respellings']) {
      const cfg = fixture({ write, batchSize: 1, batchSizeMultiplicity: 2, budget: 1 });
      const db = fakeDatabase([entry('1'), entry('2')].map((e, i) => task === 'respellings' ?
        { ...e, transcriptions: [{ id: `ipa-${i}`, transcription: '/a/', targets: [] }] } : e));
      const count = { calls: 0 };
      for (let run = 1; run <= 2; run++) {
        const ai = createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} });
        assert.equal(ai.totals().committed, 0);
        await populate(task, cfg, db, ai, { select: () => 0, log: () => {} });
        assert.equal(count.calls, run);
        assert.equal(ai.totals().known, 7150000);
      }
      if (write) assert.deepEqual(readdirSync(cfg.stateDir), []);
      else assert.equal(readdirSync(join(cfg.stateDir, 'results')).length, 2);
    }
  }
});

test('retries and uncertain costs count within a run but no history survives restart', async () => {
  const cfg = fixture({ write: true, attempts: 2, budget: 1 });
  let calls = 0;
  const ai = createAI(cfg, { fetchFn: async () => { calls++; throw new TypeError('network'); }, wait: async () => {}, log: () => {} });
  await assert.rejects(ai.generate('ipa', [{ key: '1', word: 'hello' }], source), /transport failed/);
  assert.equal(calls, 2);
  assert.ok(ai.totals().uncertain > 0);
  await assert.rejects(ai.generate('ipa', [{ key: '2', word: 'bye' }], source), BudgetReachedError);
  assert.deepEqual(readdirSync(cfg.stateDir), []);
  const next = createAI(cfg, { log: () => {} });
  assert.equal(next.totals().committed, 0);
});

test('rate limiting is rolling within one run and resets on restart', async () => {
  const cfg = fixture({ rpm: 1, write: true });
  const count = { calls: 0 }, waits = [];
  let time = 100000;
  const options = { fetchFn: fakeFetch(count), now: () => time,
    wait: async (ms) => { waits.push(ms); time += ms; }, log: () => {} };
  const ai = createAI(cfg, options);
  await ai.generate('ipa', [{ key: '1', word: 'hello' }], source);
  await ai.generate('ipa', [{ key: '2', word: 'hi' }], source);
  assert.deepEqual(waits, [60001]);
  await createAI(cfg, options).generate('ipa', [{ key: '3', word: 'bye' }], source);
  assert.deepEqual(waits, [60001]);
  assert.deepEqual(readdirSync(cfg.stateDir), []);
});

test('cache signatures distinguish database, model settings, policies, and exact IPA variants', async () => {
  const cfg = fixture();
  const count = { calls: 0 };
  const jobs = [{ key: '1', word: 'hello' }];
  const options = { fetchFn: fakeFetch(count), log: () => {} };
  await createAI(cfg, options).generate('ipa', jobs, source);
  await createAI(cfg, options).generate('ipa', jobs, source);
  assert.equal(count.calls, 1);
  await createAI({ ...cfg, databaseUrl: 'https://other.turso.io' }, options).generate('ipa', jobs, source);
  await createAI(cfg, options).generate('ipa', jobs, { ...source, dialect: 'British English' });
  const fetcher = fakeFetch(count);
  await createAI({ ...cfg, effort: 'medium' }, { log: () => {}, fetchFn: (url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.reasoning, { effort: 'medium' });
    body.reasoning.effort = 'high';
    return fetcher(url, { ...options, body: JSON.stringify(body) });
  } }).generate('ipa', jobs, source);
  for (const ipa of ['/a/', '/b/']) {
    await createAI(cfg, options).generate('respell', [{ key: '1', word: 'hello', transcription: ipa }], source, target);
  }
  assert.equal(count.calls, 6);
});

test('invalid items are skipped without storing rejections and retry naturally on the next scan', async () => {
  for (const write of [false, true]) {
    const cfg = fixture({ write });
    const db = fakeDatabase([entry('1'), entry('2')]);
    const count = { calls: 0 };
    await populate('transcriptions', cfg, db, createAI(cfg, { log: () => {}, fetchFn: fakeFetch(count,
      (rows) => answer(rows.map((r, i) => i ? { ...r, word: 'mismatch' } : r))) }), { log: () => {} });
    if (write) assert.equal(db.entries.filter((e) => e.transcriptions.length).length, 1);
    else assert.equal(readdirSync(join(cfg.stateDir, 'results')).length, 1);
    await populate('transcriptions', cfg, db, createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} }), { log: () => {} });
    assert.equal(count.calls, 2);
    assert.deepEqual(readdirSync(cfg.stateDir), write ? [] : ['results']);
  }
});

test('failed review saves no intermediate result and the next run starts generation again', async () => {
  for (const write of [false, true]) {
    const cfg = fixture({ write, attempts: 1 });
    const db = fakeDatabase([entry('1')]);
    const count = { calls: 0 };
    const ai = createAI(cfg, { log: () => {}, fetchFn: fakeFetch(count, (rows) => {
      if (count.calls === 2) throw new TypeError('network');
      return answer(rows.map((r) => (flagReview(r, 'Ambiguous'))));
    }) });
    await assert.rejects(populate('transcriptions', cfg, db, ai, { log: () => {} }), /transport failed/);
    assert.deepEqual(readdirSync(cfg.stateDir), []);
    assert.equal(db.calls.ipa, 0);
    await populate('transcriptions', cfg, db, createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} }), { log: () => {} });
    assert.equal(count.calls, 3);
  }
});

test('both scripts keep retrieving single batches by default in local and write modes', async () => {
  for (const task of ['transcriptions', 'respellings']) {
    for (const write of [false, true]) {
      const cfg = fixture({ write, batchSize: 2, rpm: 1000, tpm: 1e9 });
      const db = fakeDatabase(Array.from({ length: 5 }, (_, i) => entry(String(i))));
      const requests = [];
      const read = db.pendingEntries;
      db.pendingEntries = async (args) => { requests.push(args); return read(args); };
      const logs = [];
      const count = { calls: 0 };
      await populate(task, cfg, db, createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} }),
        { log: (message) => logs.push(message), select: () => 0 });
      assert.equal(count.calls, 3);
      assert.deepEqual(requests.map((args) => args.limit), [2, 2, 2]);
      assert.match(logs.at(-1), /Scan complete/);
      if (write) {
        assert.ok(db.entries.every((e) => e.transcriptions.length === 1));
        if (task === 'respellings') assert.ok(db.entries.every((e) => e.transcriptions[0].targets.includes('es')));
        assert.deepEqual(readdirSync(cfg.stateDir), []);
      } else {
        assert.equal(readdirSync(join(cfg.stateDir, 'results')).length, 5);
        assert.ok(db.entries.every((e) => e.transcriptions.length === 0));
      }
    }
  }
});

test('changing retrieval multiplicity reuses cached results in local and write modes for both scripts', async () => {
  for (const task of ['transcriptions', 'respellings']) {
    const cfg = fixture({ batchSize: 2, rpm: 1000, tpm: 1e9 });
    const db = fakeDatabase(Array.from({ length: 5 }, (_, i) => entry(String(i))));
    const count = { calls: 0 };
    const run = async (settings) => populate(task, settings, db,
      createAI(settings, { fetchFn: fakeFetch(count), log: () => {} }), { log: () => {}, select: () => 0 });
    await run(cfg);
    const multiplied = { ...cfg, batchSizeMultiplicity: 2 };
    await run(multiplied);
    assert.equal(count.calls, 3);
    assert.equal(readdirSync(join(cfg.stateDir, 'results')).length, 5);
    const before = snapshot(cfg.stateDir);
    await run({ ...multiplied, write: true });
    assert.equal(count.calls, 3);
    assert.ok(db.entries.every((e) => e.transcriptions.length === 1));
    if (task === 'respellings') assert.ok(db.entries.every((e) => e.transcriptions[0].targets.includes('es')));
    assert.deepEqual(snapshot(cfg.stateDir), before);
  }
});

test('completed words are filtered before limiting the retrieval window', async () => {
  for (const task of ['transcriptions', 'respellings']) {
    const cfg = fixture({ write: true, batchSize: 2, batchSizeMultiplicity: 2, rpm: 1000, tpm: 1e9 });
    const complete = (id) => entry(id, 'en', [{ id: `ipa-${id}`, transcription: '/a/', targets: ['es'] }]);
    const db = fakeDatabase([complete('0'), complete('1'), entry('2'), complete('3'),
      entry('4'), complete('5'), entry('6'), entry('7'), entry('8')]);
    const batches = [];
    const scanRequests = [];
    const read = db.pendingEntries;
    db.pendingEntries = async (args) => {
      scanRequests.push(args.limit);
      return read(args);
    };
    const count = { calls: 0 };
    const fetcher = fakeFetch(count);
    const ai = createAI(cfg, { log: () => {}, fetchFn: (url, options) => {
      batches.push(JSON.parse(JSON.parse(options.body).input[1].content).words.map((job) => job.word));
      return fetcher(url, options);
    } });
    await populate(task, cfg, db, ai, { log: () => {}, select: () => 0 });
    assert.deepEqual(batches, [['word-2', 'word-4'], ['word-6', 'word-7'], ['word-8']]);
    assert.equal(db.entries.at(-1).transcriptions.length, 1);
    assert.deepEqual(scanRequests, [4, 4]);
  }
});

test('mismatched words do not trap subsequent windows and are retried on restart in both modes', async () => {
  for (const write of [false, true]) {
    const cfg = fixture({ write, batchSize: 2, rpm: 1000, tpm: 1e9 });
    const db = fakeDatabase(Array.from({ length: 5 }, (_, i) => entry(String(i))));
    const count = { calls: 0 };
    const firstAI = createAI(cfg, { log: () => {}, fetchFn: fakeFetch(count, (rows) =>
      answer(rows.map((r) => r.word === 'word-0' ? { ...r, word: 'mismatch' } : r))) });
    await populate('transcriptions', cfg, db, firstAI, { log: () => {} });
    assert.equal(count.calls, 3);
    if (write) assert.deepEqual(db.entries.map((e) => e.transcriptions.length), [0, 1, 1, 1, 1]);
    else assert.equal(readdirSync(join(cfg.stateDir, 'results')).length, 4);
    await populate('transcriptions', cfg, db, createAI(cfg, { log: () => {}, fetchFn: fakeFetch(count) }), { log: () => {} });
    assert.equal(count.calls, 4);
    if (write) assert.ok(db.entries.every((e) => e.transcriptions.length === 1));
    else assert.equal(readdirSync(join(cfg.stateDir, 'results')).length, 5);
  }
});

test('a retrieval window is processed in batches before the next window is read for both scripts', async () => {
  for (const task of ['transcriptions', 'respellings']) {
    const cfg = fixture({ write: true, batchSize: 2, batchSizeMultiplicity: 2 });
    const db = fakeDatabase([entry('1'), entry('2'), entry('3'), entry('4'), entry('5')].map((e, i) => task === 'respellings' ?
      { ...e, transcriptions: [{ id: `ipa-${i}`, transcription: '/a/', targets: [] }] } : e));
    const events = [];
    const read = db.pendingEntries;
    db.pendingEntries = async (args) => { events.push(`read:${args.limit}`); return read(args); };
    const field = task === 'transcriptions' ? 'insertTranscriptions' : 'insertRespellings';
    const insert = db[field];
    db[field] = async (rows) => { events.push(`insert:${rows.length}`); return insert(rows); };
    const count = { calls: 0 };
    const fetcher = fakeFetch(count);
    const ai = createAI(cfg, { log: () => {}, fetchFn: (url, options) => {
      events.push(`generate:${JSON.parse(JSON.parse(options.body).input[1].content).words.length}`);
      return fetcher(url, options);
    } });
    await populate(task, cfg, db, ai, { log: () => {}, select: () => 0 });
    assert.deepEqual(events, ['read:4', 'generate:2', 'insert:2', 'generate:2', 'insert:2',
      'read:4', 'generate:1', 'insert:1']);
  }
});

test('multiplicity 3 repeatedly retrieves 300 usable words and processes batches of 100 for both scripts', async () => {
  for (const task of ['transcriptions', 'respellings']) {
    const cfg = fixture({ write: true, batchSize: 100, batchSizeMultiplicity: 3, rpm: 1000, tpm: 1e9 });
    const db = fakeDatabase(Array.from({ length: 701 }, (_, i) => entry(String(i), 'en', task === 'respellings' ?
      [{ id: `ipa-${i}`, transcription: '/a/', targets: [] }] : [])));
    const events = [];
    const read = db.pendingEntries;
    db.pendingEntries = async (args) => { events.push(`read:${args.limit}`); return read(args); };
    const fetcher = fakeFetch({ calls: 0 });
    const ai = createAI(cfg, { log: () => {}, fetchFn: (url, options) => {
      events.push(`generate:${JSON.parse(JSON.parse(options.body).input[1].content).words.length}`);
      return fetcher(url, options);
    } });
    await populate(task, cfg, db, ai, { log: () => {}, select: () => 0 });
    const fullWindow = ['read:300', ...Array(3).fill('generate:100')];
    assert.deepEqual(events, [...fullWindow, ...fullWindow, 'read:300', 'generate:100', 'generate:1']);
    assert.ok(db.entries.every((e) => e.transcriptions.length === 1));
    if (task === 'respellings') assert.ok(db.entries.every((e) => e.transcriptions[0].targets.includes('es')));
  }
});

test('retrieval finishes the selected language before switching and multiple variants share one processing batch', async () => {
  const cfg = fixture({ write: true, batchSize: 2, batchSizeMultiplicity: 2 });
  const db = fakeDatabase([entry('1'), entry('2', 'es'), entry('3', 'es'), entry('4', 'es'), entry('5', 'es')]);
  const count = { calls: 0 };
  await populate('transcriptions', cfg, db, createAI(cfg, { log: () => {}, fetchFn: fakeFetch(count) }),
    { log: () => {}, select: (n) => n - 1 });
  assert.ok(db.entries.every((e) => e.transcriptions.length === 1));
  assert.equal(db.calls.reads, 3);

  const respellingCfg = fixture({ write: true, batchSize: 1 });
  const variants = fakeDatabase([entry('1', 'en', [
    { id: 'ipa-1', transcription: '/a/', targets: [] },
    { id: 'ipa-2', transcription: '/b/', targets: [] },
    { id: 'ipa-3', transcription: '/c/', targets: [] },
  ]), entry('2')]);
  const requests = [];
  const fetcher = fakeFetch({ calls: 0 });
  await populate('respellings', respellingCfg, variants, createAI(respellingCfg, { log: () => {}, fetchFn: (url, options) => {
    requests.push(JSON.parse(JSON.parse(options.body).input[1].content).words.length);
    return fetcher(url, options);
  } }), { log: () => {}, select: () => 0 });
  assert.deepEqual(requests, [1, 1, 1, 1]);
  assert.ok(variants.entries[0].transcriptions.every((ipa) => ipa.targets.includes('es')));
  assert.equal(variants.entries[1].transcriptions.length, 1);
});

test('duplicate pronunciation documents share one result and get separate database links', async () => {
  const cfg = fixture({ write: true });
  const db = fakeDatabase([entry('1', 'en', [
    { id: 'ipa-a', transcription: '/a/', targets: [] },
    { id: 'ipa-duplicate', transcription: '/a/', targets: [] },
    { id: 'ipa-b', transcription: '/b/', targets: [] },
  ])]);
  const count = { calls: 0 };
  const fetcher = fakeFetch(count);
  const ai = createAI(cfg, { log: () => {}, fetchFn: (url, options) => {
    const input = JSON.parse(JSON.parse(options.body).input[1].content);
    assert.deepEqual(input.words.map((job) => job.transcription), ['/a/', '/b/']);
    return fetcher(url, options);
  } });
  await populate('respellings', cfg, db, ai, { select: () => 0, log: () => {} });
  assert.equal(count.calls, 1);
  assert.ok(db.entries[0].transcriptions.every((ipa) => ipa.targets.includes('es')));
  assert.deepEqual(readdirSync(cfg.stateDir), []);
});

test('budget stops finish the active batch including missing IPA and reviews and leave prefetched batches untouched', async () => {
  for (const task of ['transcriptions', 'respellings']) {
    const callsPerBatch = 2;
    for (const write of [false, true]) {
      for (const budget of [1, 7150000, callsPerBatch * 7150000]) {
        const cfg = fixture({ write, budget, batchSize: 2, batchSizeMultiplicity: 3, rpm: 1000, tpm: 1e9 });
        const db = fakeDatabase(Array.from({ length: 7 }, (_, i) => entry(String(i))));
        const reads = [];
        const read = db.pendingEntries;
        db.pendingEntries = async (args) => { reads.push(args); return read(args); };
        const count = { calls: 0 };
        const ai = createAI(cfg, { log: () => {}, fetchFn: fakeFetch(count, (rows) => answer(rows.map((r) =>
          count.calls % 2 ? flagReview(r, 'Ambiguous') : r))) });
        const logs = [];
        await populate(task, cfg, db, ai, { log: (message) => logs.push(message), select: () => 0 });
        assert.equal(count.calls, callsPerBatch);
        assert.equal(ai.totals().committed, callsPerBatch * 7150000);
        assert.deepEqual(reads.map((args) => args.limit), [6]);
        assert.match(logs.at(-1), /^Budget reached:/);
        if (write) {
          assert.deepEqual(db.entries.map((e) => e.transcriptions.length), [1, 1, 0, 0, 0, 0, 0]);
          if (task === 'respellings') assert.ok(db.entries.slice(0, 2).every((e) => e.transcriptions[0].targets.includes('es')));
          assert.deepEqual(readdirSync(cfg.stateDir), []);
        } else {
          assert.equal(readdirSync(join(cfg.stateDir, 'results')).length, 2);
          assert.ok(db.entries.every((e) => e.transcriptions.length === 0));
        }
        await assert.rejects(ai.runBatch(() => { throw new Error('A new batch must not start'); }), BudgetReachedError);
      }
    }
  }
});

test('a respelling batch finishes every pronunciation variant and its reviews after exceeding the budget', async () => {
  for (const write of [false, true]) {
    const cfg = fixture({ write, budget: 1, batchSize: 2, batchSizeMultiplicity: 3, rpm: 1000, tpm: 1e9 });
    const db = fakeDatabase([entry('0', 'en', ['a', 'b', 'c'].map((ipa) =>
      ({ id: `ipa-${ipa}`, transcription: `/${ipa}/`, targets: [] }))),
    ...Array.from({ length: 6 }, (_, i) => entry(String(i + 1)))]);
    const count = { calls: 0 };
    const ai = createAI(cfg, { log: () => {}, fetchFn: fakeFetch(count, (rows) => answer(rows.map((r) =>
      count.calls % 2 ? flagReview(r, 'Check pronunciation') : r))) });
    await populate('respellings', cfg, db, ai, { log: () => {}, select: () => 0 });
    assert.equal(count.calls, 4); // Two combined requests, each with a review.
    assert.equal(ai.totals().committed, 4 * 7150000);
    if (write) {
      assert.ok(db.entries.slice(0, 2).flatMap((e) => e.transcriptions).every((ipa) => ipa.targets.includes('es')));
      assert.equal(db.entries[1].transcriptions.length, 1);
    } else assert.equal(readdirSync(join(cfg.stateDir, 'results')).length, 4);
    assert.ok(db.entries.slice(2).every((e) => e.transcriptions.length === 0));
  }
});

test('input splitting finishes the whole processing batch after exceeding the budget', async () => {
  const cfg = fixture({ budget: 1, batchSize: 200, batchSizeMultiplicity: 2, rpm: 1000, tpm: 100000 });
  const db = fakeDatabase(Array.from({ length: 401 }, (_, i) =>
    ({ ...entry(String(i)), orthographic_form: `${i}-${'x'.repeat(480)}` })));
  const requests = [];
  let time = 100000;
  const fetcher = fakeFetch({ calls: 0 });
  const ai = createAI(cfg, { log: () => {}, now: () => time, wait: async (ms) => { time += ms; },
    fetchFn: (url, options) => {
      const body = JSON.parse(options.body);
      assert.ok(reservation(body, cfg).tokens <= cfg.tpm);
      requests.push(JSON.parse(body.input[1].content).words);
      return fetcher(url, options);
    },
  });
  await populate('transcriptions', cfg, db, ai, { log: () => {} });
  assert.ok(requests.length > 1);
  assert.deepEqual(requests.flat().map((job) => job.word), db.entries.map((e) => e.orthographic_form).sort().slice(0, 200));
  assert.equal(readdirSync(join(cfg.stateDir, 'results')).length, 200);
  assert.ok(ai.totals().committed > cfg.budget);
});

test('failed processing releases the batch scope and budget checks still apply', async () => {
  const cfg = fixture({ budget: 1 });
  const count = { calls: 0 };
  const ai = createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} });
  await assert.rejects(ai.runBatch(async () => {
    await ai.generate('ipa', [{ key: '1', word: 'hello' }], source);
    throw new Error('insertion failed');
  }), /insertion failed/);
  await assert.rejects(ai.generate('ipa', [{ key: '2', word: 'bye' }], source), BudgetReachedError);
  await assert.rejects(ai.runBatch(() => { throw new Error('Must not start'); }), BudgetReachedError);
  assert.equal(count.calls, 1);
});

test('respellings choose a fresh pair in both modes despite legacy saved selections', async () => {
  for (const write of [false, true]) {
    const cfg = fixture({ write });
    const pairPath = join(cfg.stateDir, 'respelling-pair.json');
    const saved = JSON.stringify({ source: 'missing', target: 'missing' });
    writeFileSync(pairPath, saved);
    const db = fakeDatabase([entry('1'), entry('2', 'es')]);
    const requests = [], bounds = [];
    const fetcher = fakeFetch({ calls: 0 }, (rows) => answer(rows.map((r) => ({ ...r, respelling: 'a' }))));
    const dependencies = { log: () => {}, fetchFn: (url, options) => {
      const input = JSON.parse(JSON.parse(options.body).input[1].content);
      requests.push([input.source.code, input.target.code]);
      return fetcher(url, options);
    } };
    for (const sourceIndex of [0, 1]) {
      let selections = 0;
      await populate('respellings', cfg, db, createAI(cfg, dependencies), {
        log: () => {}, select: (n) => { bounds.push(n); return selections++ === 0 ? sourceIndex : 0; },
      });
    }
    assert.deepEqual(bounds, [2, 1, 1, 1, 2, 1, 1, 1]);
    assert.deepEqual(requests, [['en', 'es'], ['es', 'en']]);
    if (write) {
      assert.deepEqual(db.entries[0].transcriptions[0].targets, ['es']);
      assert.deepEqual(db.entries[1].transcriptions[0].targets, ['en']);
    }
    assert.equal(readFileSync(pairPath, 'utf8'), saved);
  }
});

test('IPA selection uses only languages with entries and handles an empty database', async () => {
  for (const write of [false, true]) for (const entries of [[], [entry('1', 'es')]]) {
    const cfg = fixture({ write });
    const db = fakeDatabase(entries);
    const bounds = [], logs = [];
    await populate('transcriptions', cfg, db, createAI(cfg, { log: () => {}, fetchFn: fakeFetch({ calls: 0 }) }), {
      log: (message) => logs.push(message), select: (n) => { bounds.push(n); return 0; },
    });
    assert.deepEqual(bounds, entries.length ? [1] : []);
    assert.equal(db.calls.reads, entries.length);
    if (entries.length) assert.ok(logs.includes('Language: es'));
  }
});

test('both scripts move past exhausted selections without revisiting them in either mode', async () => {
  for (const write of [false, true]) for (const task of ['transcriptions', 'respellings']) {
    const cfg = fixture({ write });
    const db = fakeDatabase([
      entry('1', 'en', [{ id: 'complete', transcription: '/a/', targets: ['es'] }]),
      entry('2', 'es'),
    ]);
    const requests = [], logs = [];
    const fetcher = fakeFetch({ calls: 0 }, (rows) => answer(rows.map((r) =>
      Object.hasOwn(r, 'respelling') ? { ...r, respelling: 'a' } : r)));
    await populate(task, cfg, db, createAI(cfg, { log: () => {}, fetchFn: (url, options) => {
      const input = JSON.parse(JSON.parse(options.body).input[1].content);
      requests.push([input.source.code, input.target?.code]);
      return fetcher(url, options);
    } }), { log: (message) => logs.push(message), select: () => 0 });
    assert.deepEqual(requests, [['es', task === 'respellings' ? 'en' : undefined]]);
    assert.equal(db.calls.reads, 2);
    assert.equal(logs.filter((message) => message.startsWith('Language')).length, 2);
    assert.ok(logs.at(-1).startsWith('Scan complete.'));
  }
});

test('budget exhaustion stops rotation before selecting another language or pair', async () => {
  for (const write of [false, true]) for (const task of ['transcriptions', 'respellings']) {
    const cfg = fixture({ write, budget: 1 });
    const db = fakeDatabase([entry('1'), entry('2', 'es')]);
    const bounds = [], logs = [], count = { calls: 0 };
    await populate(task, cfg, db, createAI(cfg, { log: () => {}, fetchFn: fakeFetch(count) }), {
      log: (message) => logs.push(message), select: (n) => { bounds.push(n); return 0; },
    });
    assert.deepEqual(bounds, task === 'respellings' ? [2, 1] : [2]);
    assert.equal(count.calls, 1);
    assert.equal(db.calls.reads, 1);
    assert.equal(db.entries[1].transcriptions.length, 0);
    assert.ok(logs.at(-1).startsWith('Budget reached:'));
  }
});

test('an empty missing-word query finishes without any AI request', async () => {
  const cfg = fixture({ write: true });
  const db = fakeDatabase([entry('1', 'en', [{ id: 'existing', transcription: '/a/', targets: ['es'] }])]);
  const count = { calls: 0 };
  await populate('transcriptions', cfg, db,
    createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} }), { log: () => {} });
  assert.equal(count.calls, 0);
  assert.equal(db.calls.reads, 1);
  assert.equal(db.calls.ipa, 0);
});

test('a failed IPA refresh stops insertion after generating the finalized pair', async () => {
  const cfg = fixture({ write: true });
  const db = fakeDatabase([entry('1')]);
  db.refreshEntries = async () => { throw new Error('Entry changed before IPA refresh'); };
  const count = { calls: 0 };
  await assert.rejects(populate('respellings', cfg, db,
    createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} }), { log: () => {}, select: () => 0 }), /Entry changed before IPA refresh/);
  assert.equal(count.calls, 1);
  assert.equal(db.calls.ipa, 1);
  assert.equal(db.calls.respell, 0);
  assert.deepEqual(readdirSync(cfg.stateDir), []);
});

test('mixed IPA jobs finalize uncertain pairs and preserve accepted readings in both APIs and modes', async () => {
  for (const api of ['responses', 'chat']) for (const write of [false, true]) {
    const cfg = fixture({ api, write });
    const db = fakeDatabase([entry('1'), entry('2', 'en', [
      { id: 'present', transcription: '/riːd/', targets: [] },
      { id: 'past', transcription: '/rɛd/', targets: [] },
      { id: 'completed', transcription: '/a/', targets: ['es'] },
    ]), entry('3')]);
    const requests = [], inserted = [];
    const insert = db.insertRespellings;
    db.insertRespellings = async (rows) => { inserted.push(...rows); return insert(rows); };
    const ai = createAI(cfg, { log: () => {}, fetchFn: async (url, options) => {
      const body = JSON.parse(options.body);
      const input = JSON.parse(api === 'responses' ? body.input[1].content : body.messages[1].content);
      requests.push(input);
      assert.equal(db.calls.ipa, 0, 'Both fields must finish review before any IPA insert');
      assert.equal(db.calls.respell, 0);
      const records = input.words.map((j) => {
        if (requests.length === 1) {
          if (j.word === 'word-1') return { ...modelRespellingRow(j, 'rid'), transcription: '/riːd/',
            transcriptionStatus: 'review', note: 'Uncertain reading; verify IPA and guide' };
          if (j.word === 'word-3') return flagReview({ ...modelRespellingRow(j), transcription: '/a/' }, 'Guide uncertain');
          if (j.transcription === '/riːd/') return flagReview(modelRespellingRow(j, 'rid'), 'Mapping uncertain');
          return modelRespellingRow(j, 'red');
        }
        if (j.word === 'word-1') return { ...modelRespellingRow(j, 'red'), transcription: '/rɛd/' };
        return modelRespellingRow(j, j.word === 'word-3' ? 'a' : 'rid');
      });
      return Response.json(api === 'responses' ? answer(records) : {
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ records }) } }],
        usage: { prompt_tokens: 2000, completion_tokens: 500,
          prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 100 } },
      });
    } });
    await populate('respellings', cfg, db, ai, { select: () => 0, log: () => {} });
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].words.map((j) => [j.word, j.transcription]),
      [['word-1', null], ['word-2', '/riːd/'], ['word-2', '/rɛd/'], ['word-3', null]]);
    const review = requests[1].words;
    assert.deepEqual(review.map((j) => [j.word, j.transcription]),
      [['word-1', null], ['word-2', '/riːd/'], ['word-3', '/a/']]);
    assert.equal(review[0].candidate.transcription, '/riːd/');
    assert.equal(review[0].candidate.respelling, 'rid');
    assert.equal(review[0].candidate.respellingStatus, 'review', 'IPA uncertainty must propagate to the guide');
    if (write) {
      assert.deepEqual(inserted.map((r) => [r.orthographic_form, r.transcription, r.respelling]),
        [['word-1', '/rɛd/', 'red'], ['word-2', '/riːd/', 'rid'], ['word-2', '/rɛd/', 'red'], ['word-3', '/a/', 'a']]);
      assert.deepEqual(db.entries.filter((e) => e.id !== '2').map((e) => e.transcriptions[0].transcription), ['/rɛd/', '/a/']);
      assert.deepEqual(readdirSync(cfg.stateDir), []);
    } else {
      const saved = readdirSync(join(cfg.stateDir, 'results')).map((f) => readJson(join(cfg.stateDir, 'results', f)));
      assert.equal(saved.length, 4);
      assert.equal(saved.find((r) => r.job.word === 'word-1').transcription, '/rɛd/');
      assert.equal(saved.find((r) => r.job.word === 'word-1').respelling, 'red');
      assert.ok(saved.every((r) => !Object.hasOwn(r, 'candidate') && !Object.hasOwn(r, 'note')));
    }
  }
});

test('combined validation takes supplied IPA from input and reviews guides when the model changes it', () => {
  const job = { key: 'locked', word: 'read', transcription: '/riːd/' };
  const original = modelRespellingRow({ ...job, index: 0 }, 'rid');
  for (const transcription of ['/rɛd/', '/ḫ/', null]) for (const transcriptionStatus of ['ready', 'review', 'unknown']) {
    const output = { records: [{ ...original, transcription, transcriptionStatus }] };
    const first = validateOrderedRecords(output, [job], 'respell', target, { reviewInvalidValues: true, source });
    assert.deepEqual(first.rejected, []);
    assert.equal(first.records[0].transcription, '/riːd/');
    assert.equal(first.records[0].transcriptionStatus, 'ready');
    assert.equal(first.records[0].respellingStatus, 'review');
    assert.match(first.records[0].note, /authoritative input IPA/);
    const final = validateOrderedRecords(output, [job], 'respell', target);
    assert.deepEqual(final.records, []);
    assert.equal(final.rejected.length, 1);
    assert.match(final.rejected[0].reason, /Supplied IPA must be preserved exactly/);
  }
  const matching = validateOrderedRecords({ records: [original] }, [job], 'respell', target);
  assert.deepEqual(matching.rejected, []);
  assert.equal(matching.records[0].transcription, '/riːd/');
});

test('respelling review saves valid pairs, continues scanning and retries rejected pairs in both modes and APIs', async () => {
  for (const api of ['responses', 'chat']) for (const write of [false, true]) {
    const cfg = fixture({ api, write, batchSize: 5, batchSizeMultiplicity: 2 });
    const db = fakeDatabase(['1', '2', '3', '4', '5', '6'].map((id) => entry(id, 'en',
      id === '4' ? [{ id: 'existing', transcription: '/a/', targets: [] }] : [])));
    const requests = [], logs = [];
    let retry = false;
    const dependencies = { log: (text) => logs.push(text), fetchFn: async (url, options) => {
      const body = JSON.parse(options.body);
      const input = JSON.parse(api === 'responses' ? body.input[1].content : body.messages[1].content);
      requests.push(input.words);
      const reviewing = input.words[0].note !== undefined;
      if (reviewing) {
        assert.deepEqual(input.words.map((j) => [j.word, j.transcription]),
          [['word-1', null], ['word-2', '/a/'], ['word-3', null], ['word-4', '/a/']]);
        assert.deepEqual(input.words.map((j) => [j.candidate.transcriptionStatus, j.candidate.respellingStatus]),
          [['review', 'review'], ['ready', 'review'], ['review', 'review'], ['ready', 'review']]);
        assert.match(input.words[0].note, /U\+1E2B/);
        assert.match(input.words[1].note, /target language es/);
        assert.match(input.words[2].note, /source language en.*target language es/);
        assert.match(input.words[3].note, /authoritative input IPA/);
        assert.deepEqual(db.entries.map((e) => e.transcriptions.length), [0, 0, 0, 1, 0, 0]);
      }
      const records = input.words.map((j) => {
        const record = { ...modelRespellingRow(j, 'a'), transcription: '/a/' };
        if (retry) return record;
        if (j.word === 'word-1') return { ...record, transcription: '/ḫ/' };
        if (j.word === 'word-2') return { ...record, respelling: 'həloʊ' };
        if (j.word === 'word-3' && !reviewing) return { ...record, transcription: '/ḫ/', respelling: 'həloʊ' };
        if (j.word === 'word-4') return { ...record, transcription: reviewing ? j.transcription : '/b/' };
        return record;
      });
      return Response.json(api === 'responses' ? answer(records) : {
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ records }) } }],
        usage: { prompt_tokens: 2000, completion_tokens: 500,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
      });
    } };
    await populate('respellings', cfg, db, createAI(cfg, dependencies), { select: () => 0, log: () => {} });
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[2].map((j) => j.word), ['word-6']);
    assert.ok(logs.some((text) => text.includes('respell review: skipped "word-1": Invalid transcription value')));
    assert.ok(logs.some((text) => text.includes('respell review: skipped "word-2": Invalid respelling value')));
    if (write) {
      assert.deepEqual(db.entries.map((e) => e.transcriptions.length), [0, 0, 1, 1, 1, 1]);
      assert.ok(db.entries.slice(2).every((e) => e.transcriptions[0].transcription === '/a/' &&
        e.transcriptions[0].targets.includes('es')));
      assert.equal(db.entries[3].transcriptions[0].id, 'existing');
      assert.deepEqual(readdirSync(cfg.stateDir), []);
    } else {
      const saved = readdirSync(join(cfg.stateDir, 'results')).map((f) => readJson(join(cfg.stateDir, 'results', f)));
      assert.deepEqual(saved.map((item) => item.job.word).sort(), ['word-3', 'word-4', 'word-5', 'word-6']);
      assert.ok(saved.every((item) => item.transcription === '/a/' && item.respelling === 'a'));
      assert.deepEqual(db.entries.map((e) => e.transcriptions.length), [0, 0, 0, 1, 0, 0]);
    }
    retry = true;
    await populate('respellings', cfg, db, createAI(cfg, dependencies), { select: () => 0, log: () => {} });
    assert.equal(requests.length, 4);
    assert.deepEqual(requests[3].map((j) => j.word), ['word-1', 'word-2']);
    if (write) assert.ok(db.entries.every((e) => e.transcriptions[0].targets.includes('es')));
    else assert.equal(readdirSync(join(cfg.stateDir, 'results')).length, 6);
  }
});

test('combined validation rejects malformed records before review', () => {
  const jobs = [{ key: 'locked', word: 'read', transcription: '/riːd/' },
    { key: 'new', word: 'é', transcription: null }];
  const rows = jobs.map((j, index) => modelRespellingRow({ ...j, index }));
  for (const bad of [
    { ...rows[0], respellingStatus: 'unknown' }, { ...rows[0], word: 'wrong' },
    { ...rows[0], index: 1 }, { ...rows[0], extra: 'ignored?' },
    { ...rows[0], note: 'x'.repeat(501) }, { ...rows[0], note: 'Unexplained ready note' },
  ]) {
    const result = validateOrderedRecords({ records: [bad, rows[1]] }, jobs, 'respell', target,
      { reviewInvalidValues: true, source });
    assert.deepEqual(result.records.map((r) => r.key), ['new']);
    assert.equal(result.rejected.length, 1);
  }
  for (const records of [rows.slice(1), [...rows, rows[0]], rows.toReversed(),
    [rows[0], { ...rows[1], word: 'é' }]]) {
    const result = validateOrderedRecords({ records }, jobs, 'respell', target);
    assert.ok(result.rejected.length > 0);
  }
  assert.throws(() => validateRespellingRecord({ ...rows[1], transcriptionStatus: 'review',
    respellingStatus: 'ready', note: 'IPA uncertain' }, jobs[1], target), /Uncertain IPA/);
});

test('review IPA mismatches reject only their pairs, preserve existing or accepted IPA and retry later', async () => {
  for (const api of ['responses', 'chat']) for (const write of [false, true]) for (const existing of [false, true]) {
    const cfg = fixture({ api, write });
    const db = fakeDatabase([entry('1', 'en', existing ? [{ id: 'old', transcription: '/a/', targets: [] }] : []), entry('2')]);
    const requests = [], logs = [];
    let retry = false;
    const dependencies = { log: (text) => logs.push(text), fetchFn: async (url, options) => {
      const body = JSON.parse(options.body);
      const input = JSON.parse(api === 'responses' ? body.input[1].content : body.messages[1].content);
      requests.push(input.words);
      const reviewing = input.words[0].note !== undefined;
      if (reviewing) assert.ok(input.words.every((j) => j.transcription === '/a/'));
      const records = input.words.map((j) => {
        const record = { ...modelRespellingRow(j, 'a'), transcription: '/a/' };
        if (retry) return record;
        if (reviewing) return j.word === 'word-1' ? { ...record, transcription: '/b/', respelling: 'b' } : record;
        if (existing && j.word === 'word-1') return { ...record, transcription: '/b/', respelling: 'b' };
        return flagReview(record, 'Guide needs review');
      });
      return Response.json(api === 'responses' ? answer(records) : {
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ records }) } }],
        usage: { prompt_tokens: 2000, completion_tokens: 500,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
      });
    } };
    await populate('respellings', cfg, db, createAI(cfg, dependencies), { select: () => 0, log: () => {} });
    assert.equal(requests.length, 2);
    assert.ok(logs.some((text) => text.includes('respell review: skipped "word-1": Supplied IPA must be preserved exactly')));
    assert.equal(db.entries[0].transcriptions.length, existing ? 1 : 0);
    if (existing) {
      assert.equal(db.entries[0].transcriptions[0].id, 'old');
      assert.equal(db.entries[0].transcriptions[0].transcription, '/a/');
      assert.deepEqual(db.entries[0].transcriptions[0].targets, []);
    }
    if (write) {
      assert.equal(db.calls.ipa, 1);
      assert.equal(db.calls.respell, 1);
      assert.equal(db.entries[1].transcriptions[0].transcription, '/a/');
      assert.deepEqual(db.entries[1].transcriptions[0].targets, ['es']);
      assert.deepEqual(readdirSync(cfg.stateDir), []);
    } else {
      const saved = readdirSync(join(cfg.stateDir, 'results')).map((f) => readJson(join(cfg.stateDir, 'results', f)));
      assert.equal(saved.length, 1);
      assert.equal(saved[0].job.word, 'word-2');
      assert.equal(saved[0].transcription, '/a/');
      assert.equal(saved[0].respelling, 'a');
    }
    retry = true;
    await populate('respellings', cfg, db, createAI(cfg, dependencies), { select: () => 0, log: () => {} });
    assert.equal(requests.length, 3);
    assert.deepEqual(requests[2].map((j) => [j.word, j.transcription]), [['word-1', existing ? '/a/' : null]]);
    if (write) assert.ok(db.entries.every((e) => e.transcriptions[0].targets.includes('es')));
    else assert.equal(readdirSync(join(cfg.stateDir, 'results')).length, 2);
  }
});

test('failed combined review must be definitive, aligned and valid before saving IPA or a guide', async () => {
  const invalid = [
    (r) => ({ ...r, transcriptionStatus: 'review', respellingStatus: 'review', note: 'Still uncertain' }),
    (r) => flagReview(r, 'Still uncertain'),
    (r) => ({ ...r, transcription: null }), (r) => ({ ...r, respelling: null }),
    (r) => ({ ...r, transcription: 'not IPA' }), (r) => ({ ...r, respelling: 'həloʊ' }),
    (r) => ({ ...r, word: 'wrong' }), (r) => ({ ...r, index: 1 }),
    (r) => ({ ...r, note: 'Explanation' }),
  ];
  for (const write of [false, true]) for (const transform of invalid) {
    const cfg = fixture({ write });
    const db = fakeDatabase([entry('1')]);
    let calls = 0;
    const ai = createAI(cfg, { log: () => {}, fetchFn: async (url, options) => {
      calls++;
      const input = JSON.parse(JSON.parse(options.body).input[1].content);
      return Response.json(answer(input.words.map((j) => calls === 1 ?
        { ...modelRespellingRow(j), transcriptionStatus: 'review', respellingStatus: 'review', note: 'Resolve reading' } :
        transform(modelRespellingRow(j)))));
    } });
    await populate('respellings', cfg, db, ai, { select: () => 0, log: () => {} });
    assert.equal(db.calls.ipa, 0);
    assert.equal(db.calls.respell, 0);
    assert.deepEqual(readdirSync(cfg.stateDir), []);
  }
});

test('a concurrent different IPA is preserved and never receives a guide generated for another reading', async () => {
  const cfg = fixture({ write: true });
  const db = fakeDatabase([entry('1')]);
  const insert = db.insertTranscriptions;
  db.insertTranscriptions = async (rows) => insert(rows.map((r) => ({ ...r, transcription: '/b/' })));
  const count = { calls: 0 }, logs = [];
  await populate('respellings', cfg, db, createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} }),
    { select: () => 0, log: (s) => logs.push(s) });
  assert.equal(count.calls, 1);
  assert.equal(db.entries[0].transcriptions[0].transcription, '/b/');
  assert.deepEqual(db.entries[0].transcriptions[0].targets, []);
  assert.equal(db.calls.respell, 0);
  assert.ok(logs.some((s) => /finalized IPA not found/.test(s)));
  await populate('respellings', cfg, db, createAI(cfg, { fetchFn: fakeFetch(count), log: () => {} }),
    { select: () => 0, log: () => {} });
  assert.equal(count.calls, 2);
  assert.deepEqual(db.entries[0].transcriptions[0].targets, ['es']);
});
