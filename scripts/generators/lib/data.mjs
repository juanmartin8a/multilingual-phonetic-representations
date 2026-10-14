import { digest } from '../../utils/files.mjs';
import { isIpaCharacter, hasIpaSegment, respellingCharacters } from './characters.mjs';

const DIALECTS = {
  en: 'General American English', es: 'neutral Latin American Spanish',
  fr: 'standard metropolitan French', de: 'Standard German', ru: 'Standard Russian',
  ar: 'Modern Standard Arabic', ja: 'standard Tokyo Japanese, segmental pronunciation',
  zh: 'Beijing-based Standard Mandarin, Simplified Chinese', pt: 'Brazilian Portuguese',
};
const SCRIPTS = { Latn: 'Latin', Cyrl: 'Cyrillic', Arab: 'Arabic', Jpan: 'Japanese',
  Hans: 'Han', Hant: 'Han', Kore: 'Hangul', Grek: 'Greek', Hebr: 'Hebrew',
  Deva: 'Devanagari', Thai: 'Thai', Beng: 'Bengali', Armn: 'Armenian', Geor: 'Georgian' };

export function languagePolicy(language, overrides = {}) {
  let script;
  try { script = SCRIPTS[new Intl.Locale(language.language_code).maximize().script]; }
  catch { /* A user-supplied policy can support a non-BCP47 database code. */ }
  const override = overrides[language.language_code] ?? {};
  if (!override || typeof override !== 'object' || Array.isArray(override) || Object.entries(override).some(([key, value]) =>
    !['dialect', 'script'].includes(key) || typeof value !== 'string' || !value.trim() || value.length > 200 || /[\p{Cc}\p{Cf}]/u.test(value))) {
    throw new Error(`Invalid language policy for ${language.language_code}; only dialect/script strings are allowed`);
  }
  const policy = { code: language.language_code, name: language.name,
    dialect: DIALECTS[language.language_code] ?? `most widely understood standard variety of ${language.name}`,
    script, ...override };
  if (policy.script && policy.script !== 'Japanese') new RegExp(`\\p{Script_Extensions=${policy.script}}`, 'u');
  return policy;
}

export function choosePair(languages, randomInt, completed = new Map()) {
  if (new Set(languages.map((l) => l.language_code)).size !== languages.length) {
    throw new Error('Duplicate language codes; fix the database before selecting a pair');
  }
  const targetsFor = (source) => languages.filter((target) => target.language_code !== source.language_code &&
    !completed.get(source.language_code)?.has(target.language_code));
  const sources = languages.filter((l) => l.hasEntries && targetsFor(l).length);
  if (!sources.length) {
    if (completed.size) return null;
    throw new Error('Need at least two distinct languages and a source containing entries');
  }
  const source = sources[randomInt(sources.length)];
  const targets = targetsFor(source);
  return { source, target: targets[randomInt(targets.length)] };
}

// Model-facing records use positions and exact words; IDs stay inside the script.
export const OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['records'],
  properties: { records: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['index', 'word', 'status', 'value', 'note'],
    properties: { index: { type: 'integer' }, word: { type: 'string' },
      status: { type: 'string', enum: ['ready', 'review'] },
      value: { type: ['string', 'null'] }, note: { type: 'string' } },
  } } },
};

// A review pass must commit to one final value; it cannot defer to review again.
export const REVIEW_OUTPUT_SCHEMA = {
  ...OUTPUT_SCHEMA,
  properties: { records: { type: 'array', items: {
    ...OUTPUT_SCHEMA.properties.records.items,
    properties: { ...OUTPUT_SCHEMA.properties.records.items.properties,
      status: { type: 'string', enum: ['ready'] },
      value: { type: 'string' }, note: { type: 'string', enum: [''] },
    },
  } } },
};

export const RESPELL_OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['records'],
  properties: { records: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['index', 'word', 'transcription', 'transcriptionStatus', 'respelling', 'respellingStatus', 'note'],
    properties: { index: { type: 'integer' }, word: { type: 'string' },
      transcription: { type: ['string', 'null'] },
      transcriptionStatus: { type: 'string', enum: ['ready', 'review'] },
      respelling: { type: ['string', 'null'] },
      respellingStatus: { type: 'string', enum: ['ready', 'review'] }, note: { type: 'string' } },
  } } },
};

export const RESPELL_REVIEW_OUTPUT_SCHEMA = {
  ...RESPELL_OUTPUT_SCHEMA,
  properties: { records: { type: 'array', items: {
    ...RESPELL_OUTPUT_SCHEMA.properties.records.items,
    properties: { ...RESPELL_OUTPUT_SCHEMA.properties.records.items.properties,
      transcription: { type: 'string' }, transcriptionStatus: { type: 'string', enum: ['ready'] },
      respelling: { type: 'string' }, respellingStatus: { type: 'string', enum: ['ready'] },
      note: { type: 'string', enum: [''] },
    },
  } } },
};

export const needsRespellingReview = (record) =>
  record.transcriptionStatus === 'review' || record.respellingStatus === 'review';

export function validateRespellingRecord(record, job, target) {
  if (typeof record.note !== 'string' || record.note.length > 500) throw new Error('Invalid review note');
  if (job.transcription !== null && (record.transcription !== job.transcription || record.transcriptionStatus !== 'ready')) {
    throw new Error('Supplied IPA must be preserved exactly and remain ready');
  }
  for (const [field, valid] of [['transcription', validIpa], ['respelling', (value) => validRespelling(value, target)]]) {
    const status = record[`${field}Status`];
    if (!['ready', 'review'].includes(status)) throw new Error(`Invalid ${field} status`);
    // Uncertain candidates may be retained for the reviewer, but must be valid
    // in format. A missing candidate is allowed only for a flagged field.
    if (!(status === 'review' && record[field] === null) && !valid(record[field])) {
      throw new Error(`Invalid ${field} value`);
    }
  }
  if (record.transcriptionStatus === 'review' && record.respellingStatus !== 'review') {
    throw new Error('Uncertain IPA requires respelling review');
  }
  if (needsRespellingReview(record) ? !record.note.trim() : record.note !== '') {
    throw new Error('Review requires a note; ready pairs require an empty note');
  }
}

function repairRespellingRecord(record, source, target) {
  if (typeof record.note !== 'string' || record.note.length > 500 ||
      ![record.transcriptionStatus, record.respellingStatus].every((status) => ['ready', 'review'].includes(status))) return record;
  const notes = [];
  for (const [field, task, policy, valid] of [
    ['transcription', 'ipa', source, validIpa],
    ['respelling', 'respell', target, (value) => validRespelling(value, target)],
  ]) {
    if (!(record[`${field}Status`] === 'review' && record[field] === null) && !valid(record[field])) {
      notes.push(invalidValueNote({ value: record[field], note: '' }, task, policy));
      record = { ...record, [field]: null, [`${field}Status`]: 'review' };
    }
  }
  if (record.transcriptionStatus === 'review' && record.respellingStatus === 'ready') {
    record = { ...record, respellingStatus: 'review' };
    notes.push('Reassess the respelling against the finalized IPA.');
  }
  return notes.length ? { ...record, note: [...notes, record.note].filter(Boolean).join(' ').slice(0, 500) } : record;
}

export function validateOrderedRecords(output, jobs, task, target, { reviewInvalidValues = false, source } = {}) {
  if (!output || Array.isArray(output) || Object.keys(output).join() !== 'records' || !Array.isArray(output.records)) {
    throw new Error('Invalid structured output');
  }
  const records = [], rejected = [];
  for (const [index, job] of jobs.entries()) {
    const row = output.records[index];
    let reason;
    if (output.records.length !== jobs.length) reason = 'Incorrect record count; positional alignment cannot be trusted';
    else if (!row || Array.isArray(row) || Object.keys(row).sort().join() !== (task === 'respell' ?
      'index,note,respelling,respellingStatus,transcription,transcriptionStatus,word' : 'index,note,status,value,word')) reason = 'Malformed record';
    else if (row.index !== index) reason = 'Index does not match input position';
    else if (row.word !== job.word) reason = 'Word does not exactly match input word';
    let record = row && (task === 'respell' ? { key: job.key, transcription: row.transcription,
      transcriptionStatus: row.transcriptionStatus, respelling: row.respelling,
      respellingStatus: row.respellingStatus, note: row.note } :
      { key: job.key, status: row.status, value: row.value, note: row.note });
    if (!reason) {
      // Only correctly aligned records can enter review. The definitive review
      // pass and database validation remain strict: repair is first-pass only.
      if (task === 'respell') {
        if (job.transcription !== null && reviewInvalidValues) {
          const changed = record.transcription !== job.transcription || record.transcriptionStatus !== 'ready';
          // First-pass mismatches trigger guide review; final review must
          // preserve the input IPA exactly or the pair is rejected below.
          record = { ...record, transcription: job.transcription, transcriptionStatus: 'ready' };
          if (changed && typeof record.note === 'string' && record.note.length <= 500 &&
              ['ready', 'review'].includes(record.respellingStatus)) {
            // A guide generated against a different IPA must be reassessed.
            const note = `Use authoritative input IPA ${JSON.stringify(job.transcription)}; the returned IPA or its status was ignored. Reassess the guide against the input IPA.`;
            record = { ...record, respellingStatus: 'review',
              note: [note, record.note].filter(Boolean).join(' ').slice(0, 500) };
          }
        }
        if (reviewInvalidValues) record = repairRespellingRecord(record, source, target);
        try { validateRespellingRecord(record, job, target); }
        catch (error) { reason = error.message; }
      } else {
        if (reviewInvalidValues && ['ready', 'review'].includes(record.status) &&
            typeof record.note === 'string' && record.note.length <= 500 &&
            !(record.status === 'review' && record.value === null) &&
            !(task === 'ipa' ? validIpa(record.value) : validRespelling(record.value, target))) {
          record = { key: job.key, status: 'review', value: null,
            note: invalidValueNote(record, task, task === 'ipa' ? source : target) };
        }
        try { validateRecord(record, task, target); }
        catch (error) { reason = error.message; }
      }
    }
    if (reason) rejected.push({ job, reason, returned: row ?? null });
    else records.push(record);
  }
  return { records, rejected };
}

export function validIpa(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^\/[^/\r\n]+\/$/u.test(value)) return false;
  const body = value.slice(1, -1);
  return hasIpaSegment(body) && [...body].every(isIpaCharacter) && attachedMarks(body);
}

export function validRespelling(value, policy) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 512 ||
      /[\p{Cc}\p{Cf}\u0250-\u02af/\[\]<>]/u.test(value)) return false;
  const { allowed } = respellingCharacters(policy);
  return /\p{L}/u.test(value) && [...value.normalize('NFD')].every((c) => allowed.test(c)) && attachedMarks(value);
}

function attachedMarks(value) {
  let attached = false;
  for (const c of value.normalize('NFD')) {
    if (/\p{M}/u.test(c)) { if (!attached) return false; }
    else attached = /\p{L}/u.test(c);
  }
  return true;
}

function invalidValueNote(record, task, policy) {
  const label = task === 'ipa' ? `IPA in source language ${policy?.code ?? 'unknown'}` : `target language ${policy.code}`;
  const value = record.value;
  const body = task === 'ipa' && typeof value === 'string' && value.startsWith('/') && value.endsWith('/') ?
    value.slice(1, -1) : value;
  const allowed = task === 'respell' ? respellingCharacters(policy).allowed : null;
  const forbidden = typeof body === 'string' ? [...new Set([...body].filter((c) => task === 'ipa' ?
    !isIpaCharacter(c) : /[\p{Cc}\p{Cf}\u0250-\u02af/\[\]<>]/u.test(c) ||
      ![...c.normalize('NFD')].every((part) => allowed.test(part))))] : [];
  const characters = forbidden.slice(0, 8).map((c) => `${JSON.stringify(c)} (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`).join(', ');
  const reason = forbidden.length ? `Output includes characters not allowed for ${label}: ${characters}.` :
    `Invalid ${task} value for ${label}; correct the format, length, missing letters, or unattached marks.`;
  // Include the rejected candidate as data so the editor can diagnose its error;
  // the original word and source IPA remain authoritative.
  return `${reason} Returned value: ${JSON.stringify(value)}.${record.note ? ` Earlier note: ${record.note}` : ''}`.slice(0, 500);
}

export function validateRecord(row, task, target) {
  if (typeof row.note !== 'string' || row.note.length > 500) throw new Error('Invalid review note');
  if (row.status === 'review') {
    if (row.value !== null || !row.note.trim()) throw new Error('Review records require null and a note');
  } else if (row.status !== 'ready') throw new Error(`Invalid status: ${JSON.stringify(row.status)}`);
  else if (row.note !== '') throw new Error('Ready records require an empty note');
  else if (!(task === 'ipa' ? validIpa(row.value) : validRespelling(row.value, target))) {
    throw new Error(`Invalid ${task} value`);
  }
}

export const pronunciationKey = (entryId, ipa) => digest([entryId, ipa]);
