import { test, afterEach } from 'bun:test';
import assert from 'node:assert/strict';
import { createClient } from '@libsql/client';
import { readFileSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPopulationDatabase } from '../lib/db.mjs';
import { createAI } from '../lib/ai.mjs';
import { populate } from '../lib/run.mjs';

const clients = [], directories = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function fixture({ write = true, words = ['a', 'a', 'b', 'c', 'd'] } = {}) {
  const client = createClient({ url: ':memory:' });
  clients.push(client);
  await client.executeMultiple(readFileSync(new URL('./fixtures/turso.sql', import.meta.url), 'utf8'));
  await client.batch([
    { sql: 'INSERT INTO languages VALUES (?, ?, ?, ?)', args: ['en', 0, 'en', 'English'] },
    { sql: 'INSERT INTO languages VALUES (?, ?, ?, ?)', args: ['es', 0, 'es', 'Spanish'] },
    { sql: 'INSERT INTO languages VALUES (?, ?, ?, ?)', args: ['fr', 0, 'fr', 'French'] },
    ...words.map((word, index) => ({ sql: 'INSERT INTO entries VALUES (?, ?, ?, ?, ?)', args: [`e${index}`, 0, word, 1, 'en'] })),
  ], 'write');
  const db = createPopulationDatabase(client, { write });
  return { client, db };
}

const ipaRow = (id, word = 'a', transcription = '/a/') => ({ entry_id: id,
  orthographic_form: word, language_id: 'en', language_code: 'en', transcription });
const respellingRow = (id, word = 'a', transcription = '/a/') => ({ phonetic_transcription_id: id,
  orthographic_form: word, source_language_code: 'en', transcription,
  target_language_id: 'es', target_language_code: 'es', respelling: 'a' });
const count = async (client, table) => (await client.execute(`SELECT count(*) AS count FROM ${table}`)).rows[0].count;

// Exercise the actual SQL against the migrated schema, including duplicate words.
test('Turso pagination keeps stable boundaries after IPA insertion and advances over completed pages', async () => {
  const { db } = await fixture();
  assert.deepEqual((await db.languages()).map((language) => [language.id, language.hasEntries]),
    [['en', true], ['es', false], ['fr', false]]);
  const args = { languageCode: 'en', numItems: 2 };
  const first = await db.page(args);
  assert.deepEqual(first.page.map((entry) => entry.id), ['e0', 'e1']);
  await db.insertTranscriptions([ipaRow('e0'), ipaRow('e1')]);
  const completed = await db.page(args);
  assert.deepEqual(completed.page, []);
  assert.equal(completed.continueCursor, first.continueCursor);
  assert.equal(completed.isDone, first.isDone);
  const refreshed = await db.page({ ...args, includeCompleted: true });
  assert.deepEqual(refreshed.page.map((entry) => entry.id), ['e0', 'e1']);
  assert.ok(refreshed.page.every((entry) => entry.transcriptions[0].id));
  const second = await db.page({ ...args, cursor: first.continueCursor });
  assert.deepEqual(second.page.map((entry) => entry.id), ['e2', 'e3']);
  const last = await db.page({ ...args, cursor: second.continueCursor });
  assert.deepEqual(last.page.map((entry) => entry.id), ['e4']);
  assert.equal(last.isDone, true);
  await assert.rejects(db.page({ ...args, languageCode: 'es', cursor: first.continueCursor }), /cursor/);
  await assert.rejects(db.page({ ...args, cursor: 'bad' }), /cursor/);
  await assert.rejects(db.page({ ...args, numItems: 51 }), /Page size/);
});

test('Turso IPA inserts are idempotent, preserve variants, validate stale identities, and roll back a failed batch', async () => {
  const { client, db } = await fixture();
  await client.execute(`CREATE TRIGGER reject_second BEFORE INSERT ON phonetic_transcriptions
    WHEN NEW.entry_id = 'e1' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  await assert.rejects(db.insertTranscriptions([ipaRow('e0'), ipaRow('e1')]), /injected failure/);
  assert.equal(await count(client, 'phonetic_transcriptions'), 0);
  await client.execute('DROP TRIGGER reject_second');
  await db.insertTranscriptions([ipaRow('e0'), ipaRow('e0'), ipaRow('e1')]);
  await db.insertTranscriptions([ipaRow('e0', 'a', '/b/')]);
  assert.equal(await count(client, 'phonetic_transcriptions'), 2);
  await client.execute({ sql: 'INSERT INTO phonetic_transcriptions VALUES (?, ?, ?, ?, ?)', args: ['variant', 0, 'e0', 'ipa', '/c/'] });
  await db.insertTranscriptions([ipaRow('e0')]);
  assert.equal(await count(client, 'phonetic_transcriptions'), 3);
  await assert.rejects(db.insertTranscriptions([ipaRow('e2', 'changed')]), /Entry changed/);
  await assert.rejects(db.insertTranscriptions([ipaRow('e2', 'b', 'invalid')]), /Invalid IPA/);
  const rows = (await client.execute('SELECT * FROM phonetic_transcriptions WHERE id <> \'variant\'')).rows;
  assert.ok(rows.every((row) => row.id && row.created_at > 0 && row.type === 'ipa'));
});

test('Turso respellings link every IPA variant, skip existing targets, and validate languages and source text', async () => {
  const { client, db } = await fixture();
  await db.insertTranscriptions([ipaRow('e0')]);
  await client.execute({ sql: 'INSERT INTO phonetic_transcriptions VALUES (?, ?, ?, ?, ?)', args: ['variant', 0, 'e0', 'ipa', '/a/'] });
  const before = await db.page({ languageCode: 'en', targetLanguageCode: 'es', numItems: 1 });
  const rows = before.page[0].transcriptions.map((ipa) => respellingRow(ipa.id));
  await db.insertRespellings([...rows, rows[0]]);
  await db.insertRespellings(rows);
  assert.equal(await count(client, 'pronunciation_respellings'), 2);
  const saved = (await client.execute('SELECT * FROM pronunciation_respellings')).rows;
  assert.ok(saved.every((row) => row.entry_id === 'e0' && row.source_language_id === 'en' &&
    row.target_language_id === 'es' && row.type === 'cross-lingual' && row.created_at > 0));
  const completed = await db.page({ languageCode: 'en', targetLanguageCode: 'es', numItems: 1 });
  assert.deepEqual(completed.page, []);
  const anotherTarget = await db.page({ languageCode: 'en', targetLanguageCode: 'fr', numItems: 1 });
  assert.ok(anotherTarget.page[0].transcriptions.every((ipa) => !ipa.hasRespelling));
  await assert.rejects(db.insertRespellings([{ ...rows[0], transcription: '/wrong/' }]), /Pronunciation changed/);
  await assert.rejects(db.insertRespellings([{ ...rows[0], target_language_id: 'en', target_language_code: 'en' }]), /Invalid target/);
  await assert.rejects(db.insertRespellings([{ ...rows[0], target_language_code: 'fr' }]), /Invalid target/);
  await assert.rejects(db.insertRespellings([{ ...rows[0], respelling: 'こんにちは' }]), /Invalid respelling/);
  assert.deepEqual((await client.execute('PRAGMA foreign_key_check')).rows, []);
});

test('Turso population adapter reads without allowing accidental writes in default mode', async () => {
  const { client, db } = await fixture({ write: false });
  assert.equal((await db.page({ languageCode: 'en', numItems: 2 })).page.length, 2);
  await assert.rejects(db.insertTranscriptions([ipaRow('e0')]), /require --write/);
  await assert.rejects(db.insertRespellings([respellingRow('missing')]), /require --write/);
  assert.equal(await count(client, 'phonetic_transcriptions'), 0);
  assert.equal(await count(client, 'pronunciation_respellings'), 0);
});

test('both generators reuse local results and then insert into real SQL tables with bounded batches', async () => {
  for (const task of ['transcriptions', 'respellings']) {
    const words = Array.from({ length: 103 }, (_, index) => `word-${String(index).padStart(3, '0')}`);
    const { client } = await fixture({ words });
    const stateDir = mkdtempSync(join(tmpdir(), 'sapo-turso-'));
    directories.push(stateDir);
    const cfg = { stateDir, databaseUrl: 'https://test.turso.io', batchSize: 100, batchSizeMultiplicity: 2,
      provider: 'openai', api: 'responses', model: 'test', builtIn: false, effort: 'omit', outputTokens: 1000,
      account: 'a'.repeat(32), gateway: 'test', token: 'fake', rpm: 1000, tpm: 1e9, attempts: 1,
      timeout: 1000, budget: 1e9, prices: { input: 1000, cached: 1000, write: 1000, output: 1000 } };
    let calls = 0;
    const dependencies = { log: () => {}, fetchFn: async (url, options) => {
      calls++;
      const input = JSON.parse(JSON.parse(options.body).input[1].content);
      return Response.json({ status: 'completed', usage: { input_tokens: 100, output_tokens: 100 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ records:
          input.words.map((job) => ({ index: job.index, word: job.word, status: 'ready', note: '', value: input.target ? 'a' : '/a/' })) }) }] }] });
    } };
    const local = createPopulationDatabase(client);
    await populate(task, cfg, local, createAI(cfg, dependencies), { select: () => 0, log: () => {} });
    assert.equal(await count(client, 'phonetic_transcriptions'), 0);
    const snapshot = () => Object.fromEntries(readdirSync(stateDir, { recursive: true, withFileTypes: true })
      .filter((file) => file.isFile()).map((file) => {
        const path = join(file.parentPath, file.name);
        const info = statSync(path);
        return [path, { contents: readFileSync(path, 'utf8'), inode: info.ino, modified: info.mtimeMs }];
      }));
    const before = snapshot();
    const generatedCalls = calls;
    const writable = { ...cfg, write: true };
    const db = createPopulationDatabase(client, writable);
    const batchSizes = { ipa: [], respell: [] };
    for (const [kind, method] of [['ipa', 'insertTranscriptions'], ['respell', 'insertRespellings']]) {
      const insert = db[method];
      db[method] = async (rows) => { batchSizes[kind].push(rows.length); return insert(rows); };
    }
    await populate(task, writable, db, createAI(writable, dependencies), { select: () => 0, log: () => {} });
    assert.equal(calls, generatedCalls);
    assert.equal(await count(client, 'phonetic_transcriptions'), words.length);
    assert.equal(await count(client, 'pronunciation_respellings'), task === 'respellings' ? words.length : 0);
    assert.deepEqual(batchSizes.ipa, [50, 50, 3]);
    assert.deepEqual(batchSizes.respell, task === 'respellings' ? [50, 50, 3] : []);
    assert.deepEqual(snapshot(), before);
    await populate(task, writable, db, createAI(writable, dependencies), { select: () => 0, log: () => {} });
    assert.equal(calls, generatedCalls);
    assert.equal(await count(client, 'phonetic_transcriptions'), words.length);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual((await client.execute('PRAGMA foreign_key_check')).rows, []);
  }
});
