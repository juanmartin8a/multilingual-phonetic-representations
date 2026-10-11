import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { tursoSettings, connectTurso, withTransaction } from '../turso.mjs';
import { createGateway, requestBody, outputText, BudgetReachedError } from '../ai-gateway.mjs';

const settings = { TURSO_DATABASE_URL: 'libsql://test.turso.io', TURSO_AUTH_TOKEN: 'fake-token' };

test('shared Turso settings canonicalize database identity and reject incomplete or insecure connections', () => {
  assert.deepEqual(tursoSettings(settings), { url: 'https://test.turso.io', authToken: 'fake-token' });
  assert.equal(tursoSettings({ ...settings, TURSO_DATABASE_URL: 'https://test.turso.io/' }).url, 'https://test.turso.io');
  assert.equal(tursoSettings({ ...settings, TURSO_DATABASE_URL: 'libsql://TEST.turso.io:443/' }).url, 'https://test.turso.io');
  for (const url of [undefined, '', 'http://test.turso.io', 'file:db', 'https://user:secret@test.turso.io',
    'libsql://test.turso.io?tls=0', 'https://test.turso.io/path', 'https://test.turso.io#fragment']) {
    assert.throws(() => tursoSettings({ ...settings, TURSO_DATABASE_URL: url }), /TURSO_DATABASE_URL/);
  }
  for (const authToken of [undefined, '', ' ']) {
    assert.throws(() => tursoSettings({ ...settings, TURSO_AUTH_TOKEN: authToken }), /TURSO_AUTH_TOKEN/);
  }
});

test('shared Turso connections propagate caller cancellation and reject redirects', async () => {
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

test('the real Turso HTTP client sends authenticated SQL and decodes query results', async () => {
  let calls = 0;
  const client = connectTurso(tursoSettings(settings), { fetchFn: async (input, options) => {
    calls++;
    assert.equal(new URL(input.url).origin, 'https://test.turso.io');
    assert.equal(input.headers.get('authorization'), 'Bearer fake-token');
    assert.equal(options.redirect, 'error');
    assert.equal(options.signal.aborted, false);
    const body = await input.json();
    const execute = body.requests.find((request) => request.type === 'execute');
    assert.equal(execute.stmt.sql, 'SELECT name FROM languages WHERE id = ?');
    assert.deepEqual(execute.stmt.args, [{ type: 'text', value: 'en' }]);
    return Response.json({ baton: null, base_url: null, results: body.requests.map((request) => ({
      type: 'ok', response: request.type === 'execute' ? { type: 'execute', result: {
        cols: [{ name: 'name', decltype: 'TEXT' }], rows: [[{ type: 'text', value: 'English' }]],
        affected_row_count: 0, last_insert_rowid: null,
      } } : { type: request.type },
    })) });
  } });
  try {
    const result = await client.execute({ sql: 'SELECT name FROM languages WHERE id = ?', args: ['en'] });
    assert.equal(calls, 1);
    assert.deepEqual(result.rows.map((row) => row.name), ['English']);
  } finally { client.close(); }
});

test('Turso request deadlines abort a stalled HTTP query', async () => {
  let signal;
  const client = connectTurso(tursoSettings(settings), { timeout: 10, fetchFn: async (input, options) => {
    signal = options.signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } });
  try {
    await assert.rejects(client.execute('SELECT 1'), /timeout/i);
    assert.equal(signal.aborted, true);
  } finally { client.close(); }
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

test('a transaction commit failure rolls back and closes the transaction', async () => {
  const original = new Error('commit failed');
  const events = [];
  const client = { transaction: async () => ({
    commit: async () => { events.push('commit'); throw original; },
    rollback: async () => events.push('rollback'), close: () => events.push('close'),
  }) };
  await assert.rejects(withTransaction(client, 'write', async () => 42), (error) => error === original);
  assert.deepEqual(events, ['commit', 'rollback', 'close']);
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
