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
  await client.executeMultiple(readFileSync(new URL('../../../database/schema.sql', import.meta.url), 'utf8'));
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
test('SQL filters missing words before LIMIT and continues past duplicate spellings', async () => {
  const { db } = await fixture();
  assert.deepEqual((await db.languages()).map((language) => [language.id, language.hasEntries]),
    [['en', true], ['es', false], ['fr', false]]);
  const args = { languageId: 'en', limit: 2 };
  const first = await db.pendingEntries(args);
  assert.deepEqual(first.map((entry) => entry.id), ['e0', 'e1']);
  // Local mode leaves the same words missing; a marker advances without OFFSET.
  const second = await db.pendingEntries({ ...args, after: [first[1].orthographic_form, first[1].id] });
  assert.deepEqual(second.map((entry) => entry.id), ['e2', 'e3']);
  const last = await db.pendingEntries({ ...args, after: ['c', 'e3'] });
  assert.deepEqual(last.map((entry) => entry.id), ['e4']);
  await db.insertTranscriptions([ipaRow('e0'), ipaRow('e1')]);
  assert.deepEqual((await db.pendingEntries(args)).map((entry) => entry.id), ['e2', 'e3']);
  const refreshed = await db.refreshEntries(first, 'es');
  assert.deepEqual(refreshed.map((entry) => entry.id), ['e0', 'e1']);
  assert.ok(refreshed.every((entry) => entry.transcriptions[0].id));
  await assert.rejects(db.pendingEntries({ ...args, after: 'bad' }), /continuation marker/);
  await assert.rejects(db.pendingEntries({ ...args, limit: 0 }), /Retrieval limit/);
});

test('SQL retrieves a full window beyond 50 words and includes every missing IPA variant', async () => {
  const words = Array.from({ length: 170 }, (_, i) => `word-${String(i).padStart(3, '0')}`);
  const { client, db } = await fixture({ words });
  const originals = await db.pendingEntries({ languageId: 'en', limit: 70 });
  await db.insertTranscriptions(originals.map((e) => ipaRow(e.id, e.orthographic_form)));
  const withIpa = await db.refreshEntries(originals, 'es');
  await db.insertRespellings(withIpa.map((e) => respellingRow(e.transcriptions[0].id, e.orthographic_form)));
  for (const targetLanguageId of [null, 'es']) {
    const window = await db.pendingEntries({ languageId: 'en', targetLanguageId, limit: 100 });
    assert.equal(window.length, 100);
    assert.equal(window[0].id, 'e70');
    assert.equal(window.at(-1).id, 'e169');
    assert.deepEqual(await db.pendingEntries({ languageId: 'en', targetLanguageId,
      after: [window.at(-1).orthographic_form, window.at(-1).id], limit: 100 }), []);
  }
  await client.execute("INSERT INTO phonetic_transcriptions VALUES ('variant', 0, 'e0', 'ipa', '/b/')");
  const [word] = await db.pendingEntries({ languageId: 'en', targetLanguageId: 'es', limit: 1 });
  assert.equal(word.id, 'e0');
  assert.equal(word.transcriptions.length, 2);
  assert.equal(word.transcriptions.filter((ipa) => !ipa.hasRespelling).length, 1);
});

test('IPA refresh uses entry identity rather than neighboring words and rejects changed or deleted entries', async () => {
  const { client, db } = await fixture();
  const selected = await db.pendingEntries({ languageId: 'en', limit: 2 });
  await db.insertTranscriptions(selected.map((e) => ipaRow(e.id, e.orthographic_form)));
  await client.execute("INSERT INTO entries VALUES ('neighbor', 0, 'a', 1, 'en')");
  const refreshed = await db.refreshEntries(selected, 'es');
  assert.deepEqual(refreshed.map((e) => e.id), selected.map((e) => e.id));
  await client.execute("UPDATE entries SET orthographic_form = 'changed' WHERE id = 'e0'");
  await assert.rejects(db.refreshEntries(selected, 'es'), /Entry changed/);
  await client.execute("UPDATE entries SET orthographic_form = 'a', language_id = 'fr' WHERE id = 'e0'");
  await assert.rejects(db.refreshEntries(selected, 'es'), /Entry changed/);
  const unpopulated = await db.pendingEntries({ languageId: 'en', limit: 10 });
  await client.execute({ sql: 'DELETE FROM entries WHERE id = ?', args: [unpopulated[0].id] });
  await assert.rejects(db.refreshEntries(unpopulated, 'es'), /Entry changed/);
});

test('the schema prevents duplicate guides and the existing-database migration preserves records', async () => {
  const { client, db } = await fixture();
  await db.insertTranscriptions([ipaRow('e0')]);
  const [word] = await db.pendingEntries({ languageId: 'en', targetLanguageId: 'es', limit: 1 });
  await db.insertRespellings([respellingRow(word.transcriptions[0].id)]);
  const duplicate = `INSERT INTO pronunciation_respellings
    SELECT 'duplicate', created_at, entry_id, phonetic_transcription_id, target_language_id,
      type, respelling, source_language_id FROM pronunciation_respellings LIMIT 1`;
  await assert.rejects(client.execute(duplicate), /UNIQUE/);
  await client.execute('DROP INDEX pronunciation_respellings_unique_target');
  await client.execute(`CREATE INDEX pronunciation_respellings_by_phonetic_transcription_and_target
    ON pronunciation_respellings(phonetic_transcription_id, target_language_id)`);
  await client.execute(duplicate);
  const schema = readFileSync(new URL('../../../database/schema.sql', import.meta.url), 'utf8');
  const uniqueIndex = schema.match(/CREATE UNIQUE INDEX IF NOT EXISTS pronunciation_respellings_unique_target\s+ON pronunciation_respellings\(phonetic_transcription_id, target_language_id\);/)[0];
  const migrate = () => client.batch([uniqueIndex,
    'DROP INDEX IF EXISTS pronunciation_respellings_by_phonetic_transcription_and_target'], 'write');
  await assert.rejects(migrate(), /UNIQUE/);
  assert.equal(await count(client, 'pronunciation_respellings'), 2);
  assert.ok((await client.execute("PRAGMA index_list('pronunciation_respellings')")).rows
    .some((index) => index.name === 'pronunciation_respellings_by_phonetic_transcription_and_target'));
  await client.execute("DELETE FROM pronunciation_respellings WHERE id = 'duplicate'");
  await migrate();
  await migrate(); // Safe to apply again.
  assert.equal(await count(client, 'pronunciation_respellings'), 1);
  await assert.rejects(client.execute(duplicate), /UNIQUE/);
  const indexes = (await client.execute("PRAGMA index_list('pronunciation_respellings')")).rows;
  assert.ok(indexes.some((index) => index.name === 'pronunciation_respellings_unique_target' && index.unique));
  assert.ok(!indexes.some((index) => index.name === 'pronunciation_respellings_by_phonetic_transcription_and_target'));
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
  const before = await db.pendingEntries({ languageId: 'en', targetLanguageId: 'es', limit: 1 });
  const rows = before[0].transcriptions.map((ipa) => respellingRow(ipa.id));
  await db.insertRespellings([...rows, rows[0]]);
  await db.insertRespellings(rows);
  assert.equal(await count(client, 'pronunciation_respellings'), 2);
  const saved = (await client.execute('SELECT * FROM pronunciation_respellings')).rows;
  assert.ok(saved.every((row) => row.entry_id === 'e0' && row.source_language_id === 'en' &&
    row.target_language_id === 'es' && row.type === 'cross-lingual' && row.created_at > 0));
  const completed = await db.pendingEntries({ languageId: 'en', targetLanguageId: 'es', limit: 1 });
  assert.equal(completed[0].id, 'e1');
  const anotherTarget = await db.pendingEntries({ languageId: 'en', targetLanguageId: 'fr', limit: 1 });
  assert.ok(anotherTarget[0].transcriptions.every((ipa) => !ipa.hasRespelling));
  await assert.rejects(db.insertRespellings([{ ...rows[0], transcription: '/wrong/' }]), /Pronunciation changed/);
  await assert.rejects(db.insertRespellings([{ ...rows[0], target_language_id: 'en', target_language_code: 'en' }]), /Invalid target/);
  await assert.rejects(db.insertRespellings([{ ...rows[0], target_language_code: 'fr' }]), /Invalid target/);
  await assert.rejects(db.insertRespellings([{ ...rows[0], respelling: 'こんにちは' }]), /Invalid respelling/);
  assert.deepEqual((await client.execute('PRAGMA foreign_key_check')).rows, []);
});

test('Turso population adapter reads without allowing accidental writes in default mode', async () => {
  const { client, db } = await fixture({ write: false });
  assert.equal((await db.pendingEntries({ languageId: 'en', limit: 2 })).length, 2);
  await assert.rejects(db.insertTranscriptions([ipaRow('e0')]), /require --write/);
  await assert.rejects(db.insertRespellings([respellingRow('missing')]), /require --write/);
  assert.equal(await count(client, 'phonetic_transcriptions'), 0);
  assert.equal(await count(client, 'pronunciation_respellings'), 0);
});

test('both generators reuse local results and then insert into real SQL tables with writes sized by configuration', async () => {
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
    assert.deepEqual(batchSizes.ipa, [100, 3]);
    assert.deepEqual(batchSizes.respell, task === 'respellings' ? [100, 3] : []);
    assert.deepEqual(snapshot(), before);
    await populate(task, writable, db, createAI(writable, dependencies), { select: () => 0, log: () => {} });
    assert.equal(calls, generatedCalls);
    assert.equal(await count(client, 'phonetic_transcriptions'), words.length);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual((await client.execute('PRAGMA foreign_key_check')).rows, []);
  }
});
