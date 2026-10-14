import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { atomicJson, digest, readJson } from '../../utils/files.mjs';
import { createGateway, MAX_INPUT_RESERVATION, reservedInput, outputText,
  requestBody as gatewayRequestBody } from '../../utils/ai-gateway.mjs';
import { OUTPUT_SCHEMA, REVIEW_OUTPUT_SCHEMA, RESPELL_OUTPUT_SCHEMA, RESPELL_REVIEW_OUTPUT_SCHEMA,
  validateRecord, validateRespellingRecord, validateOrderedRecords, needsRespellingReview, validIpa } from './data.mjs';
import { ipaCharacterPrompt, respellingCharacterPrompt } from './characters.mjs';

function requestBody(cfg, prompt, input, schema = OUTPUT_SCHEMA) {
  const words = input.words.map((job, index) => ({ index, word: job.word,
    ...(job.transcription !== undefined ? { transcription: job.transcription } : {}),
    ...(job.note !== undefined ? { note: job.note } : {}),
    ...(job.candidate !== undefined ? { candidate: job.candidate } : {}) }));
  return gatewayRequestBody(cfg, prompt, { ...input, words }, schema, 'sapo_phonetic_population');
}

export function createAI(cfg, dependencies = {}) {
  const log = dependencies.log ?? console.log;
  const gateway = createGateway(cfg, { ...dependencies, metadata: { task: 'sapo-phonetics', ...dependencies.metadata } });
  const prompts = Object.fromEntries(['ipa', 'respell'].map((task) =>
    [task, readFileSync(new URL(`../prompts/${task}.md`, import.meta.url), 'utf8')]));
  const reviewPrompts = Object.fromEntries(['ipa', 'respell'].map((task) =>
    [task, readFileSync(new URL(`../prompts/${task}-review.md`, import.meta.url), 'utf8')]));

  function nextBatch(items, offset, prompt, input, schema = OUTPUT_SCHEMA) {
    let size = Math.min(cfg.batchSize, items.length - offset);
    while (true) {
      const batch = items.slice(offset, offset + size);
      const body = requestBody(cfg, prompt, { ...input, words: batch }, schema);
      const inputTokens = reservedInput(body);
      if (size === 1 || (inputTokens <= MAX_INPUT_RESERVATION && inputTokens + cfg.outputTokens <= cfg.tpm)) {
        return { batch, body };
      }
      size = Math.max(1, Math.floor(size / 2));
    }
  }

  async function generate(task, jobs, source, target = null, onBatch = async () => {}) {
    if (new Set(jobs.map((job) => job.key)).size !== jobs.length) throw new Error('Duplicate input job keys');
    if (!prompts[task]) throw new Error('Unknown generation task');
    const combined = task === 'respell';
    if (combined) {
      if (jobs.some((job) => job.transcription === undefined)) {
        throw new Error('Respelling jobs require supplied IPA or transcription: null');
      }
      jobs = jobs.filter((job) => {
        if (job.transcription === null || validIpa(job.transcription)) return true;
        log(`respell: skipped ${JSON.stringify(job.word)}: supplied IPA ${JSON.stringify(job.transcription)} has an incompatible format or character inventory; correct the stored IPA before retrying`);
        return false;
      });
    }
    const schema = combined ? RESPELL_OUTPUT_SCHEMA : OUTPUT_SCHEMA;
    const reviewSchema = combined ? RESPELL_REVIEW_OUTPUT_SCHEMA : REVIEW_OUTPUT_SCHEMA;
    const isReview = combined ? needsRespellingReview : (record) => record.status === 'review';
    const characterPrompt = combined ? `${ipaCharacterPrompt()}\n${respellingCharacterPrompt(target)}` : ipaCharacterPrompt();
    const prompt = `${prompts[task]}\n${characterPrompt}`;
    const reviewPrompt = `${reviewPrompts[task]}\n${characterPrompt}\nLanguage policies (data):\n${JSON.stringify({ source, ...(target ? { target } : {}) })}`;
    const signature = digest({ task, prompt, reviewPrompt, schema, reviewSchema,
      model: cfg.model, provider: cfg.provider, effort: cfg.effort, api: cfg.api });
    // Cache lookup hints are internal metadata, not part of the request identity.
    // Keeping them out also preserves the filenames of existing local results.
    const cacheJob = ({ cacheFallback, ...job }) => job;
    const pathFor = (job) => resolve(cfg.stateDir, 'results', `${digest([cfg.databaseUrl, signature, cacheJob(job)])}.json`);
    const results = new Map();
    const missing = [], cached = [];
    async function emit(records) {
      await onBatch(records);
      // Write mode releases each finalized batch after insertion.
      if (!cfg.write) for (const record of records) results.set(record.key, record);
    }
    for (const job of jobs) {
      let saved = readJson(pathFor(job));
      if (!saved && combined && job.transcription !== null && job.cacheFallback) {
        // An import may have saved IPA and failed before inserting its guide.
        // Reuse the earlier finalized pair only for the exact stored reading.
        const fallback = readJson(pathFor(job.cacheFallback));
        if (fallback?.transcription === job.transcription) saved = fallback;
      }
      if (saved) {
        const record = combined ? { key: job.key, transcription: saved.transcription, transcriptionStatus: 'ready',
          respelling: saved.respelling, respellingStatus: 'ready', note: '' } :
          { key: job.key, status: 'ready', value: saved.value, note: '' };
        if (combined) validateRespellingRecord(record, job, target);
        else validateRecord(record, task, target);
        cached.push(record);
        if (cached.length === cfg.batchSize) await emit(cached.splice(0));
      } else missing.push(job);
    }
    if (cached.length) await emit(cached.splice(0));
    for (let offset = 0; offset < missing.length;) {
      gateway.assertBudget();
      const { batch, body } = nextBatch(missing, offset, prompt, { source, ...(target ? { target } : {}) }, schema);
      const response = await gateway.request(body);
      const validated = validateOrderedRecords(JSON.parse(outputText(response, cfg.api)), batch, task, target,
        { reviewInvalidValues: true, source });
      const records = new Map(validated.records.map((record) => [record.key, record]));
      if (validated.rejected.length) log(`${task}: ${validated.rejected.length} invalid items skipped; rerun to retry`);
      for (const { job, reason, returned } of validated.rejected) {
        log(`${task}: skipped ${JSON.stringify(job.word)}: ${reason}; returned ${JSON.stringify(returned)}`);
      }
      const flagged = batch.filter((job) => records.has(job.key) && isReview(records.get(job.key))).map((job) => {
        const record = records.get(job.key);
        if (!combined) return { ...job, note: record.note };
        const { key, note, ...candidate } = record;
        // Freeze accepted IPA, including newly generated IPA whose respelling
        // alone needs review. Uncertain generated IPA remains replaceable.
        return { ...job, transcription: record.transcriptionStatus === 'ready' ? record.transcription : null,
          note, candidate };
      });
      let reviewCount = 0;
      for (let reviewOffset = 0; reviewOffset < flagged.length;) {
        const { batch: reviewJobs, body: reviewBody } = nextBatch(flagged, reviewOffset, reviewPrompt, {}, reviewSchema);
        const response = await gateway.request(reviewBody);
        const reviewed = validateOrderedRecords(JSON.parse(outputText(response, cfg.api)), reviewJobs, task, target);
        if (combined && (reviewed.rejected.length || reviewed.records.some(isReview))) {
          throw new Error(`${task} review pass rejected: every reviewed word must have a valid definitive value`);
        }
        // Remove first-pass candidates so rejected reviews cannot be saved.
        for (const job of reviewJobs) records.delete(job.key);
        const definitive = reviewed.records.filter((record) => !isReview(record));
        const rejected = [...reviewed.rejected, ...reviewed.records.filter(isReview).map((record) => ({
          job: reviewJobs.find((job) => job.key === record.key),
          reason: 'Review output must be definitive and ready', returned: record,
        }))];
        if (rejected.length) log(`${task} review: ${rejected.length} invalid items skipped; rerun to retry`);
        for (const { job, reason, returned } of rejected) {
          log(`${task} review: skipped ${JSON.stringify(job.word)}: ${reason}; returned ${JSON.stringify(returned)}`);
        }
        for (const record of definitive) records.set(record.key, record);
        reviewCount += definitive.length;
        reviewOffset += reviewJobs.length;
      }
      const ready = [...records.values()];
      if (!cfg.write) for (const job of batch) {
        const record = records.get(job.key);
        if (record) atomicJson(pathFor(job), { task, job: cacheJob(job), source: source.code,
          ...(target ? { target: target.code } : {}), signature,
          ...(combined ? { transcription: record.transcription, respelling: record.respelling } : { value: record.value }) });
      }
      await emit(ready);
      log(`${task}: ${ready.length} finalized${flagged.length ? ` (${reviewCount} reviewed)` : ''}`);
      offset += batch.length;
    }
    return results;
  }
  return { generate, runBatch: gateway.runBatch, totals: gateway.totals };
}
