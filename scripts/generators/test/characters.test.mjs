import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validIpa, validRespelling, validateOrderedRecords, languagePolicy } from '../lib/data.mjs';
import { respellingCharacters, respellingCharacterPrompt } from '../lib/characters.mjs';
import { createAI } from '../lib/ai.mjs';
import { configuration } from '../lib/config.mjs';
import { populate } from '../lib/run.mjs';

const policy = (code) => languagePolicy({ language_code: code, name: code });
const source = policy('ar'), target = policy('es');
const job = { key: 'private-id', word: 'الاخري' };
const pairedRow = (j, transcription, respelling, extra = {}) => ({ index: j.index ?? 0, word: j.word,
  transcription, transcriptionStatus: 'ready', respelling, respellingStatus: 'ready', note: '', ...extra });
const row = (value, extra = {}) => ({ index: 0, word: job.word, status: 'ready', value, note: '', ...extra });
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function config(extra) {
  const stateDir = mkdtempSync(join(tmpdir(), 'sapo-characters-'));
  dirs.push(stateDir);
  return { ...configuration('transcriptions', [], {
    TURSO_DATABASE_URL: 'libsql://test.turso.io', TURSO_AUTH_TOKEN: 'fake-db', CLOUDFLARE_API_TOKEN: 'fake-gateway',
  }, () => JSON.stringify({ cloudflare: { accountId: 'a'.repeat(32), gatewayId: 'test' }, limits: { maxUsd: '10' } })),
  stateDir, ...extra };
}

function response(records, api) {
  const text = JSON.stringify({ records });
  return new Response(JSON.stringify(api === 'chat' ? {
    choices: [{ finish_reason: 'stop', message: { content: text } }],
    usage: { prompt_tokens: 100, completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
  } : {
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 100, output_tokens: 100,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
  }));
}
const inputOf = (body, api) => JSON.parse(api === 'chat' ? body.messages[1].content : body.input[1].content);
const promptOf = (body, api) => api === 'chat' ? body.messages[0].content : body.input[0].content[0].text;

test('IPA accepts official segments, clicks, releases, diacritics and tones but rejects romanization and unrelated characters', () => {
  for (const value of ['/alʔuxraː/', '/ǃa/', '/ɓa/', '/ʄa/', '/ⱱa/', '/a˞/', '/tⁿ/', '/tʰ/',
    '/ɚɝ/', '/t͡ʃ/', '/t͜s/', '/n̥/', '/ã/', '/ã/', '/ç/', '/ç/', '/ni˧˥/', '/a᷄/', '/aꜛ/', '/a↗/', '/a‿a/', '/a|a‖a/', '/gɡ/']) {
    assert.ok(validIpa(value), value);
  }
  for (const value of ['/al-ʔuḫrā/', '/alʔuḫrā/', '/ḫ/', '/A/', '/а/', '/ε/', '/α/', '/你好/',
    '/a1/', '/a\u200b/', '/a🙂/', '/ʰ/', '/˥/', '/̃a/', '/a ̃/', 'a', '//', '/a/b/', '/a\n/']) {
    assert.equal(validIpa(value), false, value);
  }
  // Macron is an official tone mark; it cannot be banned as romanization globally.
  assert.ok(validIpa('/ā/'));
});

test('native target alphabets, script overrides and canonical marks share one character policy', () => {
  for (const [code, value] of [['en', 'heh-LOH'], ['es', 'jelóu'], ['fr', 'cœur'], ['de', 'größer'],
    ['pt', 'ação'], ['ru', 'хэло́у'], ['ar', 'هَلُو'], ['ja', 'ハロー'], ['ja', 'ガ'], ['zh', '你好'],
    ['ko', '안녕'], ['hi', 'नमस्ते'], ['he', 'שָׁלוֹם'], ['el', 'γειά']]) {
    const p = policy(code);
    assert.ok(validRespelling(value, p), `${code}: ${value}`);
    assert.ok(validRespelling(value.normalize('NFD'), p), `${code}: decomposed ${value}`);
    const { allowed } = respellingCharacters(p);
    assert.ok([...value.normalize('NFD')].every((c) => allowed.test(c)));
  }
  for (const value of ['ḫ', 'ə', 'hello🙂', 'hello\u200b', 'helloа', 'jeloु', '/jelo/', 'jelo1', '́jelo', 'je-́lo', 'ñ']) {
    assert.equal(validRespelling(value, policy('en')), false, value);
  }
  assert.ok(validRespelling('ñ', policy('es')));
  assert.equal(validRespelling('њ', policy('ru')), false);
  assert.ok(validRespelling('њ', { code: 'sr', script: 'Cyrillic' }));
  assert.ok(validRespelling('hola', { code: 'ru', script: 'Latin' }));
  assert.ok(validRespelling('jelóu', policy('es-MX')));
  assert.throws(() => respellingCharacters({ code: 'x' }), /No script policy/);
  assert.ok(respellingCharacterPrompt(policy('zh')).length < 6000, 'Han is encoded as ranges, not all characters');
});

test('invalid first-pass values become review with diagnostic notes, including existing review candidates', () => {
  for (const [task, value] of [['ipa', '/al-ʔuḫrā/'], ['respell', 'həloʊ'], ['ipa', 'alʔuxraː'],
    ['respell', ''], ['ipa', null], ['respell', 'a'.repeat(513)]]) {
    for (const status of ['ready', 'review']) {
      if (status === 'review' && value === null) continue;
      const inputJob = task === 'ipa' ? job : { ...job, transcription: '/alʔuxraː/' };
      const original = task === 'ipa' ? row(value, { status, note: status === 'review' ? 'Existing uncertainty' : '' }) :
        pairedRow(job, inputJob.transcription, value, { respellingStatus: status, note: status === 'review' ? 'Existing uncertainty' : '' });
      const result = validateOrderedRecords({ records: [original] }, [inputJob], task, target,
        { reviewInvalidValues: true, source });
      assert.equal(result.rejected.length, 0);
      assert.equal(result.records[0][task === 'ipa' ? 'status' : 'respellingStatus'], 'review');
      assert.equal(result.records[0][task === 'ipa' ? 'value' : 'respelling'], null);
      assert.ok(result.records[0].note.length <= 500);
      assert.match(result.records[0].note, task === 'ipa' ? /source language ar/ : /target language es/);
      if (value === '/al-ʔuḫrā/') {
        assert.match(result.records[0].note, /characters not allowed/);
        assert.match(result.records[0].note, /U\+002D/);
        assert.match(result.records[0].note, /U\+1E2B/);
      }
      if (status === 'review' && value.length < 100) assert.match(result.records[0].note, /Existing uncertainty/);
      // Definitive review cannot repair itself or write an invalid value.
      assert.equal(validateOrderedRecords({ records: [original] }, [inputJob], task, target).rejected.length, 1);
    }
  }
  const review = row(null, { status: 'review', note: 'Ambiguous reading' });
  const result = validateOrderedRecords({ records: [review] }, [job], 'ipa', null,
    { reviewInvalidValues: true, source });
  assert.equal(result.records[0].note, review.note);
  for (const mismatch of [row('/ḫ/', { word: 'wrong' }), row('/ḫ/', { index: 1 }), row('/ḫ/', { status: 'unknown' })]) {
    assert.equal(validateOrderedRecords({ records: [mismatch] }, [job], 'ipa', null,
      { reviewInvalidValues: true, source }).rejected.length, 1);
  }
});

test('both APIs inject only the requested target inventory before words and repair invalid values before saving', async () => {
  for (const api of ['responses', 'chat']) for (const task of ['ipa', 'respell']) {
    const cfg = config({ api });
    const requests = [], emissions = [], logs = [];
    const jobs = [{ ...job, ...(task === 'respell' ? { transcription: '/alʔuxraː/' } : {}) }, { key: 'other-id', word: 'hello', ...(task === 'respell' ? { transcription: null } : {}) }];
    const ai = createAI(cfg, { log: (s) => logs.push(s), fetchFn: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const input = inputOf(body, api);
      const prompt = promptOf(body, api);
      assert.match(prompt, task === 'ipa' ? /Allowed IPA characters/ : /Allowed respelling characters for es/);
      if (task === 'ipa') {
        assert.match(prompt, /never romanization ḫ/);
        assert.match(prompt, /ː/);
      } else {
        const injected = JSON.parse(prompt.split('Target character inventory (data): ')[1].split('\n')[0]);
        assert.equal(injected.code, 'es');
        assert.ok(injected.characters.includes('ñ'));
        for (const unrelated of ['ã', 'œ', 'ß', 'а', 'ه', 'ハ']) assert.equal(injected.characters.includes(unrelated), false);
        assert.equal(prompt.includes('Allowed IPA characters'), true);
      }
      assert.equal(JSON.stringify(body).includes('private-id'), false);
      const review = input.words[0].note !== undefined;
      if (review) {
        assert.equal(input.words.length, 1, 'Only the invalid candidate enters review');
        assert.equal(input.words[0].word, job.word);
        assert.match(input.words[0].note, /characters not allowed/);
        if (task === 'respell') assert.equal(input.words[0].transcription, '/alʔuxraː/');
        assert.deepEqual(emissions, [], 'Nothing emits before review completes');
      }
      return response(input.words.map((j) => task === 'ipa' ? { index: j.index, word: j.word, status: 'ready', note: '',
        value: !review && j.word === job.word ? '/al-ʔuḫrā/' : '/alʔuxraː/' } :
        pairedRow(j, j.transcription ?? '/alʔuxraː/', !review && j.word === job.word ? 'həloʊ' : 'al ujrá')), api);
    } });
    const result = await ai.generate(task, jobs, source, task === 'respell' ? target : null,
      async (rows) => emissions.push(rows));
    assert.equal(requests.length, 2);
    assert.equal(result.size, 2);
    assert.ok(logs.some((s) => /2 finalized \(1 reviewed\)/.test(s)));
    const saved = readdirSync(join(cfg.stateDir, 'results')).map((file) => JSON.parse(readFileSync(join(cfg.stateDir, 'results', file))));
    assert.equal(saved.length, 2);
    assert.ok(saved.every((r) => (task === 'ipa' ? r.value === '/alʔuxraː/' : r.respelling === 'al ujrá' && r.transcription === '/alʔuxraː/')));
  }
});

test('population repairs both missing IPA and respellings before their database insert, with strict final review', async () => {
  for (const failedTask of [null, 'ipa', 'respell']) {
    const cfg = config({ write: true });
    const stages = [];
    const e = { id: 'ar-word', language_id: 'ar-id', language_code: 'ar', orthographic_form: job.word, transcriptions: [] };
    const db = {
      languages: async () => [{ id: 'ar-id', language_code: 'ar', name: 'Arabic', hasEntries: true },
        { id: 'es-id', language_code: 'es', name: 'Spanish', hasEntries: false }],
      pendingEntries: async () => [structuredClone(e)],
      refreshEntries: async () => [structuredClone(e)],
      insertTranscriptions: async (rows) => {
        stages.push('insert-ipa');
        assert.equal(rows[0].transcription, '/alʔuxraː/');
        e.transcriptions.push({ id: 'ipa-id', transcription: rows[0].transcription, hasRespelling: false });
      },
      insertRespellings: async (rows) => { stages.push('insert-respell'); assert.equal(rows[0].respelling, 'al ujrá'); },
    };
    const ai = createAI(cfg, { log: () => {}, fetchFn: async (url, options) => {
      const body = JSON.parse(options.body), input = inputOf(body, 'responses');
      const review = input.words[0].note !== undefined;
      stages.push(review ? 'pair-review' : 'pair-first');
      if (review) {
        assert.equal(input.words[0].transcription, null);
        assert.equal(input.words[0].candidate.transcriptionStatus, 'review');
        assert.equal(input.words[0].candidate.respellingStatus, 'review');
        assert.deepEqual(e.transcriptions, [], 'Review must finish before either field is inserted');
      }
      return response(input.words.map((j) => pairedRow(j,
        review && failedTask !== 'ipa' ? '/alʔuxraː/' : '/al-ʔuḫrā/',
        review && failedTask !== 'respell' ? 'al ujrá' : 'həloʊ')), 'responses');
    } });
    if (failedTask) {
      await populate('respellings', cfg, db, ai, { log: () => {}, select: () => 0 });
      assert.deepEqual(stages, ['pair-first', 'pair-review']);
      assert.deepEqual(e.transcriptions, []);
    } else {
      await populate('respellings', cfg, db, ai, { log: () => {}, select: () => 0 });
      assert.deepEqual(stages, ['pair-first', 'pair-review', 'insert-ipa', 'insert-respell']);
    }
    assert.deepEqual(readdirSync(cfg.stateDir), []);
  }
});
