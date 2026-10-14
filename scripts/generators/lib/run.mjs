import { resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { configuration, help } from './config.mjs';
import { atomicJson, readJson } from '../../utils/files.mjs';
import { choosePair, languagePolicy, pronunciationKey } from './data.mjs';
import { connect } from './db.mjs';
import { createAI } from './ai.mjs';
import { BudgetReachedError } from '../../utils/ai-gateway.mjs';

async function insertBatches(insert, rows, size) {
  for (const batch of batches(rows, size)) await insert(batch);
}

function* batches(items, size) {
  for (let offset = 0; offset < items.length; offset += size) yield items.slice(offset, offset + size);
}

async function processBatch(cfg, db, ai, entries, source, target, log) {
  const missing = entries.filter((entry) => entry.transcriptions.length === 0);
  const pending = entries.reduce((sum, entry) => sum + entry.transcriptions.filter((t) => !t.hasRespelling).length, 0);
  log(`${source.code}: ${entries.length} words, ${missing.length} missing IPA` +
    (target ? `, ${pending} missing ${target.code} respellings (+ words needing IPA)` : ''));
  if (!target) {
    const byId = new Map(missing.map((entry) => [entry.id, entry]));
    await ai.generate('ipa', missing.map((entry) => ({ key: entry.id, word: entry.orthographic_form })),
      source, null, async (records) => {
        if (!cfg.write) return;
        await insertBatches(db.insertTranscriptions, records.map((record) => {
          const entry = byId.get(record.key);
          return { entry_id: entry.id, orthographic_form: entry.orthographic_form,
            language_id: entry.language_id, language_code: source.code, transcription: record.value };
        }), cfg.batchSize);
      });
    return;
  }

  // Each missing reading is an independent job. Entries without IPA contribute
  // one job with null IPA; duplicate IPA documents share a generated pair.
  const candidates = entries.flatMap((entry) => (entry.transcriptions.length ?
    entry.transcriptions.filter((t) => !t.hasRespelling) : [{ transcription: null }])
    .map((transcription) => ({ entry, transcription,
      key: pronunciationKey(entry.id, transcription.transcription) })));
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const jobs = [...byKey.values()].map(({ key, entry, transcription }) =>
    ({ key, word: entry.orthographic_form, transcription: transcription.transcription,
      // Existing IPA may be the result of a partially imported local pair.
      ...(transcription.transcription !== null ? { cacheFallback: {
        key: pronunciationKey(entry.id, null), word: entry.orthographic_form, transcription: null,
      } } : {}) }));
  await ai.generate('respell', jobs, source, target, async (records) => {
    if (!cfg.write || !records.length) return;
    // Neither component is written until the complete pair has passed review.
    const newIpa = records.filter((record) => byKey.get(record.key).transcription.transcription === null);
    let refreshed = new Map();
    if (newIpa.length) {
      await insertBatches(db.insertTranscriptions, newIpa.map((record) => {
        const { entry } = byKey.get(record.key);
        return { entry_id: entry.id, orthographic_form: entry.orthographic_form,
          language_id: entry.language_id, language_code: source.code, transcription: record.transcription };
      }), cfg.batchSize);
      refreshed = new Map((await db.refreshEntries(newIpa.map((record) => byKey.get(record.key).entry),
        cfg.targetId)).map((entry) => [entry.id, entry]));
    }
    const values = new Map(records.map((record) => [record.key, record]));
    const rows = [];
    for (const { key, entry, transcription } of candidates) {
      const record = values.get(key);
      if (!record) continue;
      const readings = transcription.transcription === null ?
        refreshed.get(entry.id)?.transcriptions.filter((t) => t.transcription === record.transcription) ?? [] :
        [transcription];
      // A concurrent writer may have inserted a different reading. Never attach
      // this guide to that IPA; a later scan will generate its own respelling.
      if (!readings.length) log(`respell: skipped ${JSON.stringify(entry.orthographic_form)}: finalized IPA not found after insertion; rerun to retry`);
      for (const reading of readings.filter((t) => !t.hasRespelling)) rows.push({
        phonetic_transcription_id: reading.id, transcription: record.transcription,
        orthographic_form: entry.orthographic_form, source_language_code: source.code,
        target_language_id: cfg.targetId, target_language_code: target.code, respelling: record.respelling,
      });
    }
    await insertBatches(db.insertRespellings, rows, cfg.batchSize);
  });
}

export async function populate(task, cfg, db, ai, { log = console.log, select = randomInt } = {}) {
  const languages = (await db.languages()).sort((a, b) => a.language_code.localeCompare(b.language_code));
  if (new Set(languages.map((l) => l.language_code)).size !== languages.length) throw new Error('Duplicate language codes');
  let target = null, selected;
  if (task === 'respellings') {
    const pairPath = resolve(cfg.stateDir, 'respelling-pair.json');
    const saved = readJson(pairPath);
    selected = saved ? { source: languages.find((l) => l.language_code === saved.source),
      target: languages.find((l) => l.language_code === saved.target) } : choosePair(languages, select);
    if (!selected.source || !selected.target || selected.source.language_code === selected.target.language_code) {
      throw new Error('Saved language pair no longer exists');
    }
    cfg.targetId = selected.target.id;
    target = languagePolicy(selected.target, cfg.languagePolicies);
    if (!target.script) throw new Error(`Configure a native script policy for target ${target.code}`);
    if (!cfg.write && !saved) atomicJson(pairPath,
      { source: selected.source.language_code, target: selected.target.language_code });
    log(`Language pair: ${selected.source.language_code} -> ${target.code}`);
  }
  const ordered = selected ? [selected.source] : languages.filter((l) => l.hasEntries);
  const windowSize = cfg.batchSize * cfg.batchSizeMultiplicity;
  function stopForBudget() {
    log(`Budget reached: $${(ai.totals().committed / 1e9).toFixed(6)} committed this run; $${(cfg.budget / 1e9).toFixed(6)} limit. Completed batches ${cfg.write ? 'inserted' : 'saved locally'}; rerun for a fresh budget.`);
  }
  for (const language of ordered) {
    let after = null;
    while (true) {
      if (ai.totals().committed >= cfg.budget) { stopForBudget(); return; }
      const pending = await db.pendingEntries({ languageId: language.id, after, limit: windowSize,
        targetLanguageId: target ? cfg.targetId : null });
      if (!pending.length) break;
      const last = pending.at(-1);
      after = [last.orthographic_form, last.id];
      for (const batch of batches(pending, cfg.batchSize)) {
        try {
          await ai.runBatch(() => processBatch(cfg, db, ai, batch,
            languagePolicy(language, cfg.languagePolicies), target, log));
        } catch (error) {
          if (!(error instanceof BudgetReachedError)) throw error;
          stopForBudget();
          return;
        }
        if (ai.totals().committed >= cfg.budget) { stopForBudget(); return; }
      }
      if (pending.length < windowSize) break;
    }
  }
  log(`Scan complete. Finalized results ${cfg.write ? 'inserted into the database' : 'saved locally'}. Rerun to retry skipped items.`);
}

export async function main(task) {
  let ai, db;
  try {
    const cfg = configuration(task);
    if (cfg.help) { console.log(help(task)); return; }
    db = connect(cfg);
    ai = createAI(cfg);
    await populate(task, cfg, db, ai);
  } catch (error) {
    console.error(`Stopped: ${error.message}`);
    process.exitCode = 1;
  } finally {
    db?.close();
    if (ai) {
      const total = ai.totals();
      console.log(JSON.stringify({ knownCostUSD: total.known / 1e9, uncertainUpperBoundUSD: total.uncertain / 1e9,
        budgetCommittedUSD: total.committed / 1e9, usage: total.usage }));
    }
  }
}
