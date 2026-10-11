import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { tursoSettings, connectTurso, withTransaction } from '../turso.mjs';
import { createGateway, requestBody, outputText, BudgetReachedError } from '../ai-gateway.mjs';

const settings = { TURSO_DATABASE_URL: 'libsql://test.turso.io', TURSO_AUTH_TOKEN: 'fake-token' };

test('shared Turso settings canonicalize database identity and reject incomplete or insecure connections', () => {
  assert.deepEqual(tursoSettings(settings), { url: 'https://test.turso.io', authToken: 'fake-token' });
  assert.equal(tursoSettings({ ...settings, TURSO_DATABASE_URL: 'https://test.turso.io/' }).url, 'https://test.turso.io');
  for (const url of [undefined, '', 'http://test.turso.io', 'file:db', 'https://user:secret@test.turso.io',
    'libsql://test.turso.io?tls=0', 'https://test.turso.io/path', 'https://test.turso.io#fragment']) {
    assert.throws(() => tursoSettings({ ...settings, TURSO_DATABASE_URL: url }), /TURSO_DATABASE_URL/);
  }
  for (const authToken of [undefined, '', ' ']) {
    assert.throws(() => tursoSettings({ ...settings, TURSO_AUTH_TOKEN: authToken }), /TURSO_AUTH_TOKEN/);
  }
});

test('shared Turso connections enforce redirect rejection, timeouts, and caller cancellation', async () => {
  let config;
  const controller = new AbortController();
  const client = connectTurso(tursoSettings(settings), { createClientFn: (value) => { config = value; return 'client'; },
    fetchFn: async (input, options) => {
      assert.equal(options.redirect, 'error');
      assert.equal(options.signal.aborted, true);
      return 'response';
    } });
  assert.equal(client, 'client');
  assert.equal(config.url, 'https://test.turso.io');
  assert.equal(config.authToken, 'fake-token');
  controller.abort();
  assert.equal(await config.fetch(new Request('https://test.turso.io', { signal: controller.signal })), 'response');
});

test('shared transactions commit on success and preserve the failure after rollback and cleanup', async () => {
  for (const fails of [false, true]) {
    const events = [];
    const original = new Error('operation failed');
    const client = { transaction: async (mode) => {
      events.push(mode);
      return { commit: async () => events.push('commit'), rollback: async () => { events.push('rollback'); throw new Error('rollback failed'); },
        close: () => events.push('close') };
    } };
    const execute = () => withTransaction(client, 'write', async () => { if (fails) throw original; return 42; });
    if (fails) await assert.rejects(execute, (error) => error === original);
    else assert.equal(await execute(), 42);
    assert.deepEqual(events, ['write', fails ? 'rollback' : 'commit', 'close']);
  }
});

test('shared Gateway supports unrelated script payloads and caller metadata while accounting for budgets', async () => {
  const cfg = { provider: 'openai', api: 'responses', model: 'test', builtIn: false, effort: 'omit', outputTokens: 1000,
    account: 'a'.repeat(32), gateway: 'test', token: 'fake', rpm: 1000, tpm: 1e9, attempts: 1,
    timeout: 1000, budget: 1, prices: { input: 1000, cached: 1000, write: 1000, output: 1000 } };
  const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false };
  let calls = 0;
  const gateway = createGateway(cfg, { log: () => {}, metadata: { task: 'summarize' }, fetchFn: async (url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.deepEqual(JSON.parse(body.input[1].content), { document: 'Example content' });
    assert.equal(body.text.format.name, 'summary');
    assert.deepEqual(body.text.format.schema, schema);
    const metadata = JSON.parse(options.headers['cf-aig-metadata']);
    assert.equal(metadata.task, 'summarize');
    assert.ok(metadata.request);
    assert.equal(new Headers(options.headers).has('authorization'), false);
    return Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 100 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"summary":"Done"}' }] }] });
  } });
  const body = requestBody(cfg, 'Summarize', { document: 'Example content' }, schema, 'summary');
  await gateway.runBatch(async () => {
    const response = await gateway.request(body);
    assert.deepEqual(JSON.parse(outputText(response, cfg.api)), { summary: 'Done' });
    gateway.assertBudget();
    await gateway.request(body);
  });
  assert.equal(calls, 2);
  assert.equal(gateway.totals().known, 400000);
  assert.equal(gateway.totals().uncertain, 0);
  assert.throws(() => gateway.assertBudget(), BudgetReachedError);
  await assert.rejects(gateway.runBatch(async () => {}), BudgetReachedError);
});
