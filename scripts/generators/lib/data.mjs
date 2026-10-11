import { digest } from '../../utils/files.mjs';

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

export function choosePair(languages, randomInt) {
  if (new Set(languages.map((l) => l.language_code)).size !== languages.length) {
    throw new Error('Duplicate language codes; fix the database before selecting a pair');
  }
  const sources = languages.filter((l) => l.hasEntries && languages.some((t) => t.language_code !== l.language_code));
  if (!sources.length) throw new Error('Need at least two distinct languages and a source containing entries');
  const source = sources[randomInt(sources.length)];
  const targets = languages.filter((l) => l.language_code !== source.language_code);
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

export function validateOrderedRecords(output, jobs, task, target) {
  if (!output || Array.isArray(output) || Object.keys(output).join() !== 'records' || !Array.isArray(output.records)) {
    throw new Error('Invalid structured output');
  }
  const records = [], rejected = [];
  for (const [index, job] of jobs.entries()) {
    const row = output.records[index];
    let reason;
    if (output.records.length !== jobs.length) reason = 'Incorrect record count; positional alignment cannot be trusted';
    else if (!row || Array.isArray(row) || Object.keys(row).sort().join() !== 'index,note,status,value,word') reason = 'Malformed record';
    else if (row.index !== index) reason = 'Index does not match input position';
    else if (row.word !== job.word) reason = 'Word does not exactly match input word';
    const record = row && { key: job.key, status: row.status, value: row.value, note: row.note };
    if (!reason) {
      try { validateRecord(record, task, target); }
      catch (error) { reason = error.message; }
    }
    if (reason) rejected.push({ job, reason, returned: row ?? null });
    else records.push(record);
  }
  return { records, rejected };
}

export function validIpa(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^\/[^/\r\n]+\/$/u.test(value)) return false;
  const body = value.slice(1, -1);
  return /[\p{L}]/u.test(body) && /^[\p{Script=Latin}\p{Script=Greek}\p{M} .ˈˌːˑ˥˦˧˨˩ꜛꜜʰʲʷˠˤⁿˡʱʼʔʕ͜͡]+$/u.test(body);
}

export function validRespelling(value, policy) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 512 ||
      /[\p{Cc}\p{Cf}\u0250-\u02af/\[\]<>]/u.test(value)) return false;
  if (!policy.script) throw new Error(`No script policy for target ${policy.code}; configure languagePolicies in YAML`);
  const scripts = policy.script === 'Japanese' ? ['Hiragana', 'Katakana', 'Han'] : [policy.script];
  const letters = new RegExp(`^[${scripts.map((s) => `\\p{Script_Extensions=${s}}`).join('')}\\p{M} '\u2019\u2010\u2011\u30fc-]+$`, 'u');
  return /\p{L}/u.test(value) && letters.test(value);
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
