import { resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { configuration, help } from './config.mjs';
import { atomicJson, readJson } from '../../utils/files.mjs';
import { choosePair, languagePolicy, pronunciationKey } from './data.mjs';
import { connect } from './db.mjs';
import { createAI } from './ai.mjs';
import { BudgetReachedError } from '../../utils/ai-gateway.mjs';

async function insertBatches(insert, rows) {
  for (let offset = 0; offset < rows.length; offset += 50) await insert(rows.slice(offset, offset + 50));
}

function* processingBatches(pages, size) {
  let batch = [], words = 0;
  for (const page of pages) {
    for (let offset = 0; offset < page.result.page.length;) {
      const entries = page.result.page.slice(offset, offset + size - words);
      batch.push({ args: page.args, result: { ...page.result, page: entries } });
      words += entries.length;
      offset += entries.length;
      if (words === size) {
        yield batch;
        batch = [];
        words = 0;
      }
    }
  }
  if (words) yield batch;
}

async function processPages(cfg, db, ai, pages, source, target, log) {
  let entries = pages.flatMap(({ result }) => result.page);
  const missing = entries.filter((entry) => entry.transcriptions.length === 0);
  const pending = entries.reduce((sum, entry) => sum + entry.transcriptions.filter((t) => !t.hasRespelling).length, 0);
  log(`${source.code}: ${entries.length} words, ${missing.length} missing IPA` +
    (target ? `, ${pending} missing ${target.code} respellings (+ words needing IPA)` : ''));
  const byId = new Map(missing.map((entry) => [entry.id, entry]));
  const ipa = await ai.generate('ipa', missing.map((entry) => ({ key: entry.id, word: entry.orthographic_form })),
    source, null, async (records) => {
      if (!cfg.write) return;
      await insertBatches(db.insertTranscriptions, records.map((record) => {
        const entry = byId.get(record.key);
        return { entry_id: entry.id, orthographic_form: entry.orthographic_form,
          language_id: entry.language_id, language_code: source.code, transcription: record.value };
      }));
    });
  if (!target) return;
  if (cfg.write && missing.length) {
    // Resolve real IPA IDs after insertion before linking respellings.
    const refreshed = [];
    for (const page of pages) {
      const result = await db.page({ ...page.args, includeCompleted: true });
      if (result.continueCursor !== page.result.continueCursor || result.isDone !== page.result.isDone) {
        throw new Error('Entries changed during this page; rerun before generating respellings');
      }
      const ids = new Set(page.result.page.map((entry) => entry.id));
      refreshed.push(...result.page.filter((entry) => ids.has(entry.id)));
    }
    entries = refreshed;
  } else if (!cfg.write) {
    entries = entries.map((entry) => ({ ...entry,
      transcriptions: entry.transcriptions.length ? entry.transcriptions : ipa.has(entry.id) ?
        [{ transcription: ipa.get(entry.id).value, hasRespelling: false }] : [],
    }));
  }
  const candidates = entries.flatMap((entry) => entry.transcriptions.filter((t) => !t.hasRespelling)
    .map((transcription) => ({ entry, transcription, key: pronunciationKey(entry.id, transcription.transcription) })));
  // Duplicate IPA documents share generated text, but each gets its own link.
  const jobs = [...new Map(candidates.map(({ key, entry, transcription }) => [key,
    { key, word: entry.orthographic_form, ipa: transcription.transcription }])).values()];
  await ai.generate('respell', jobs, source, target, async (records) => {
    if (!cfg.write) return;
    const values = new Map(records.map((record) => [record.key, record.value]));
    await insertBatches(db.insertRespellings, candidates.filter(({ key }) => values.has(key))
      .map(({ key, entry, transcription }) => ({
        phonetic_transcription_id: transcription.id, transcription: transcription.transcription,
        orthographic_form: entry.orthographic_form, source_language_code: source.code,
        target_language_id: cfg.targetId, target_language_code: target.code, respelling: values.get(key),
      })));
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
    let cursor = null, buffered = null, exhausted = false;
    while (buffered || !exhausted) {
      if (ai.totals().committed >= cfg.budget) { stopForBudget(); return; }
      const pending = [];
      let words = 0;
      while (words < windowSize && (buffered || !exhausted)) {
        if (!buffered) {
          const args = { languageCode: language.language_code, cursor, numItems: Math.min(50, windowSize - words),
            ...(target ? { targetLanguageCode: target.code } : {}) };
          const result = await db.page(args);
          if (!result.isDone && result.continueCursor === cursor) throw new Error('Pagination did not advance');
          // Only words needing this task count toward the retrieval window.
          const usable = result.page.filter((entry) => entry.transcriptions.length === 0 ||
            (target && entry.transcriptions.some((t) => !t.hasRespelling)));
          cursor = result.continueCursor;
          exhausted = result.isDone;
          if (!usable.length) continue;
          buffered = { args, result: { ...result, page: usable } };
        }
        const page = buffered.result.page.slice(0, windowSize - words);
        pending.push({ args: buffered.args, result: { ...buffered.result, page } });
        words += page.length;
        const remainder = buffered.result.page.slice(page.length);
        buffered = remainder.length ? { ...buffered, result: { ...buffered.result, page: remainder } } : null;
      }
      if (!words) break;
      for (const batch of processingBatches(pending, cfg.batchSize)) {
        try {
          await ai.runBatch(() => processPages(cfg, db, ai, batch,
            languagePolicy(language, cfg.languagePolicies), target, log));
        } catch (error) {
          if (!(error instanceof BudgetReachedError)) throw error;
          stopForBudget();
          return;
        }
        if (ai.totals().committed >= cfg.budget) { stopForBudget(); return; }
      }
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
