import { randomUUID } from 'node:crypto';
import { connectTurso, withTransaction } from '../../utils/turso.mjs';
import { languagePolicy, validIpa, validRespelling } from './data.mjs';

const placeholders = (rows) => rows.map(() => '?').join(', ');

function pageCursor(cursor, languageCode) {
  if (cursor === null || cursor === undefined) return null;
  let value;
  try { value = JSON.parse(cursor); } catch { throw new Error('Invalid page cursor'); }
  if (!Array.isArray(value) || value.length !== 3 || value.some((part) => typeof part !== 'string') ||
      value[0] !== languageCode) throw new Error('Invalid page cursor for language');
  return value.slice(1);
}

export function createPopulationDatabase(client, { write = false, languagePolicies = {} } = {}) {
  function checkWrite(rows) {
    if (!write) throw new Error('Database writes require --write');
    if (!Array.isArray(rows) || rows.length > 50) throw new Error('Insert batches must contain at most 50 records');
  }

  return {
    close: () => client.close(),
    async languages() {
      const result = await client.execute(`SELECT l.id, l.language_code, l.name,
        EXISTS (SELECT 1 FROM entries e WHERE e.language_id = l.id) AS hasEntries
        FROM languages l ORDER BY l.language_code`);
      return result.rows.map((row) => ({ id: row.id, language_code: row.language_code,
        name: row.name, hasEntries: Boolean(row.hasEntries) }));
    },
    async page({ languageCode, cursor = null, numItems, targetLanguageCode = null, includeCompleted = false }) {
      if (!Number.isSafeInteger(numItems) || numItems < 1 || numItems > 50) throw new Error('Page size must be from 1 to 50');
      const after = pageCursor(cursor, languageCode);
      return withTransaction(client, 'read', async (transaction) => {
        // Scan a stable range, then filter completed words. IPA insertion must
        // not change cursor boundaries when this page is refreshed.
        const result = await transaction.execute({
          sql: `SELECT e.id, e.orthographic_form, e.language_id FROM entries e
            WHERE e.language_id = (SELECT id FROM languages WHERE language_code = ?)
            ${after ? 'AND (e.orthographic_form, e.id) > (?, ?)' : ''}
            ORDER BY e.orthographic_form, e.id LIMIT ?`,
          args: [languageCode, ...(after ?? []), numItems + 1],
        });
        const scanned = result.rows.slice(0, numItems);
        const isDone = result.rows.length <= numItems;
        const last = scanned.at(-1);
        const continueCursor = last ? JSON.stringify([languageCode, last.orthographic_form, last.id]) : cursor;
        if (!scanned.length) return { page: [], continueCursor, isDone };
        const transcriptions = await transaction.execute({
          sql: `SELECT p.id, p.entry_id, p.transcription,
            EXISTS (SELECT 1 FROM pronunciation_respellings r
              WHERE r.phonetic_transcription_id = p.id AND r.target_language_id =
                (SELECT id FROM languages WHERE language_code = ?)) AS hasRespelling
            FROM phonetic_transcriptions p WHERE p.type = 'ipa' AND p.entry_id IN (${placeholders(scanned)})
            ORDER BY p.created_at, p.id`,
          args: [targetLanguageCode, ...scanned.map((entry) => entry.id)],
        });
        const byEntry = new Map(scanned.map((entry) => [entry.id, []]));
        for (const row of transcriptions.rows) {
          byEntry.get(row.entry_id).push({ id: row.id, transcription: row.transcription, hasRespelling: Boolean(row.hasRespelling) });
        }
        const entries = scanned.map((entry) => ({ id: entry.id, orthographic_form: entry.orthographic_form,
          language_id: entry.language_id, language_code: languageCode, transcriptions: byEntry.get(entry.id) }));
        const page = includeCompleted ? entries : entries.filter((entry) => !entry.transcriptions.length ||
          (targetLanguageCode && entry.transcriptions.some((ipa) => !ipa.hasRespelling)));
        return { page, continueCursor, isDone };
      });
    },
    async insertTranscriptions(rows) {
      checkWrite(rows);
      if (!rows.length) return;
      for (const row of rows) if (!validIpa(row.transcription)) throw new Error('Invalid IPA transcription');
      return withTransaction(client, 'write', async (transaction) => {
        const existing = await transaction.execute({
          sql: `SELECT e.id, e.orthographic_form, e.language_id, l.language_code
            FROM entries e JOIN languages l ON l.id = e.language_id WHERE e.id IN (${placeholders(rows)})`,
          args: rows.map((row) => row.entry_id),
        });
        const entries = new Map(existing.rows.map((entry) => [entry.id, entry]));
        for (const row of rows) {
          const entry = entries.get(row.entry_id);
          if (!entry || entry.orthographic_form !== row.orthographic_form || entry.language_id !== row.language_id ||
              entry.language_code !== row.language_code) throw new Error('Entry changed before IPA insertion');
        }
        await transaction.batch(rows.map((row) => ({
          sql: `INSERT INTO phonetic_transcriptions (id, created_at, entry_id, type, transcription)
            SELECT ?, ?, ?, 'ipa', ? WHERE NOT EXISTS
              (SELECT 1 FROM phonetic_transcriptions WHERE entry_id = ? AND type = 'ipa')`,
          args: [randomUUID(), Date.now(), row.entry_id, row.transcription, row.entry_id],
        })));
      });
    },
    async insertRespellings(rows) {
      checkWrite(rows);
      if (!rows.length) return;
      return withTransaction(client, 'write', async (transaction) => {
        const existing = await transaction.execute({
          sql: `SELECT p.id, p.entry_id, p.transcription, e.orthographic_form, e.language_id, l.language_code
            FROM phonetic_transcriptions p JOIN entries e ON e.id = p.entry_id
            JOIN languages l ON l.id = e.language_id WHERE p.type = 'ipa' AND p.id IN (${placeholders(rows)})`,
          args: rows.map((row) => row.phonetic_transcription_id),
        });
        const pronunciations = new Map(existing.rows.map((ipa) => [ipa.id, ipa]));
        const targets = await transaction.execute('SELECT id, language_code, name FROM languages');
        const languages = new Map(targets.rows.map((language) => [language.id, language]));
        for (const row of rows) {
          const ipa = pronunciations.get(row.phonetic_transcription_id);
          const target = languages.get(row.target_language_id);
          if (!ipa || ipa.transcription !== row.transcription || ipa.orthographic_form !== row.orthographic_form ||
              ipa.language_code !== row.source_language_code) throw new Error('Pronunciation changed before respelling insertion');
          if (!target || target.language_code !== row.target_language_code || target.id === ipa.language_id) {
            throw new Error('Invalid target language for cross-lingual respelling');
          }
          if (!validRespelling(row.respelling, languagePolicy(target, languagePolicies))) throw new Error('Invalid respelling');
        }
        await transaction.batch(rows.map((row) => {
          const ipa = pronunciations.get(row.phonetic_transcription_id);
          return {
            sql: `INSERT INTO pronunciation_respellings
              (id, created_at, entry_id, phonetic_transcription_id, target_language_id, type, respelling, source_language_id)
              SELECT ?, ?, ?, ?, ?, 'cross-lingual', ?, ? WHERE NOT EXISTS
                (SELECT 1 FROM pronunciation_respellings WHERE phonetic_transcription_id = ? AND target_language_id = ?)`,
            args: [randomUUID(), Date.now(), ipa.entry_id, ipa.id, row.target_language_id, row.respelling,
              ipa.language_id, ipa.id, row.target_language_id],
          };
        }));
      });
    },
  };
}

export function connect(cfg) {
  return createPopulationDatabase(connectTurso({ url: cfg.databaseUrl, authToken: cfg.databaseToken }), cfg);
}
