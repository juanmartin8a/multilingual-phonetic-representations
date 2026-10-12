import { randomUUID } from 'node:crypto';
import { connectTurso, withTransaction } from '../../utils/turso.mjs';
import { languagePolicy, validIpa, validRespelling } from './data.mjs';

const placeholders = (rows) => rows.map(() => '?').join(', ');

const entryIds = (entries) => JSON.stringify(entries.map((entry) => entry.id));

async function withTranscriptions(transaction, entries, targetLanguageId) {
  if (!entries.length) return [];
  const result = await transaction.execute({
    sql: `SELECT p.id, p.entry_id, p.transcription,
      EXISTS (SELECT 1 FROM pronunciation_respellings r
        WHERE r.phonetic_transcription_id = p.id AND r.target_language_id = ?) AS hasRespelling
      FROM phonetic_transcriptions p WHERE p.type = 'ipa'
        AND p.entry_id IN (SELECT value FROM json_each(?)) ORDER BY p.created_at, p.id`,
    args: [targetLanguageId, entryIds(entries)],
  });
  const byEntry = new Map(entries.map((entry) => [entry.id, []]));
  for (const row of result.rows) byEntry.get(row.entry_id).push({
    id: row.id, transcription: row.transcription, hasRespelling: Boolean(row.hasRespelling),
  });
  return entries.map((entry) => ({ ...entry, transcriptions: byEntry.get(entry.id) }));
}

export function createPopulationDatabase(client, { write = false, languagePolicies = {} } = {}) {
  function checkWrite(rows) {
    if (!write) throw new Error('Database writes require --write');
    if (!Array.isArray(rows) || rows.length > 1000) throw new Error('Insert batches must contain at most 1000 records');
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
    async pendingEntries({ languageId, after = null, limit, targetLanguageId = null }) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Retrieval limit must be a positive safe integer');
      if (after !== null && (!Array.isArray(after) || after.length !== 2 ||
          after.some((part) => typeof part !== 'string'))) throw new Error('Invalid continuation marker');
      return withTransaction(client, 'read', async (transaction) => {
        const result = await transaction.execute({
          sql: `SELECT e.id, e.orthographic_form, e.language_id FROM entries e
            WHERE e.language_id = ?
            ${after ? 'AND (e.orthographic_form, e.id) > (?, ?)' : ''}
            AND (NOT EXISTS (SELECT 1 FROM phonetic_transcriptions p WHERE p.entry_id = e.id AND p.type = 'ipa')
              ${targetLanguageId !== null ? `OR EXISTS (SELECT 1 FROM phonetic_transcriptions p
                WHERE p.entry_id = e.id AND p.type = 'ipa' AND NOT EXISTS
                  (SELECT 1 FROM pronunciation_respellings r
                    WHERE r.phonetic_transcription_id = p.id AND r.target_language_id = ?))` : ''})
            ORDER BY e.orthographic_form, e.id LIMIT ?`,
          args: [languageId, ...(after ?? []), ...(targetLanguageId !== null ? [targetLanguageId] : []), limit],
        });
        return targetLanguageId === null ? result.rows.map((entry) => ({ ...entry, transcriptions: [] })) :
          withTranscriptions(transaction, result.rows, targetLanguageId);
      });
    },
    async refreshEntries(entries, targetLanguageId = null) {
      if (!entries.length) return [];
      return withTransaction(client, 'read', async (transaction) => {
        const result = await transaction.execute({
          sql: 'SELECT id, orthographic_form, language_id FROM entries WHERE id IN (SELECT value FROM json_each(?))',
          args: [entryIds(entries)],
        });
        const current = new Map(result.rows.map((entry) => [entry.id, entry]));
        for (const entry of entries) {
          const saved = current.get(entry.id);
          if (!saved || saved.orthographic_form !== entry.orthographic_form || saved.language_id !== entry.language_id) {
            throw new Error('Entry changed before IPA refresh');
          }
        }
        return withTranscriptions(transaction, entries, targetLanguageId);
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
        const targetIds = [...new Set(rows.map((row) => row.target_language_id))];
        const targets = await transaction.execute({
          sql: `SELECT id, language_code, name FROM languages WHERE id IN (${placeholders(targetIds)})`,
          args: targetIds,
        });
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
