// Unicode spellings from the IPA Association's chart and symbol identifiers:
// https://www.internationalphoneticassociation.org/IPAcharts/common_files/pdfs/pdfs_IPA_charts_E/IPA_DejaVu_sl.pdf
// Main chart revised to 2015/2005; symbol list accessed 2026-10-11.
// Additional symbols documented in that list are separate from the main chart.
const IPA_CHARACTERS = {
  consonants: 'pbtdʈɖcɟkɡqɢʔmɱnɳɲŋɴʙrʀⱱɾɽɸβfvθðszʃʒʂʐçʝxɣχʁħʕhɦɬɮʋɹɻjɰlɭʎʟʘǀǃǂǁɓɗʄɠʛʍwɥʜʢʡɕʑɺɧɫ',
  vowels: 'iyɨʉɯuɪʏʊeøɘɵɤoəɛœɜɞʌɔæɐaɶɑɒɚ',
  modifiers: 'ʼʰʷʲˠˤ˞ⁿˡ',
  suprasegmentals: 'ˈˌːˑ.|‖‿',
  tones: '˥˦˧˨˩ꜛꜜ↗↘',
  // Code points avoid ambiguity between visually similar combining marks.
  combining: '\u0325\u032c\u030a\u0339\u031f\u0308\u0329\u0330\u031c\u0320\u033d\u032f\u0324\u033c\u0334\u031e\u0319\u033a\u0303\u031d\u0318\u032a\u033b\u031a\u0306\u030b\u0301\u0304\u0300\u030f\u030c\u0302\u1dc4\u1dc5\u1dc8\u035c\u0361',
  additional: 'ɝʳʵˀʱʴʶ\u0322\u1dc6\u1dc7\u1dc9',
  // ASCII g is a conventional glyph alternative to script g; spaces separate words.
  compatibility: 'g ',
};

const ipaSet = new Set([...Object.values(IPA_CHARACTERS).join('')].flatMap((c) => [c, ...c.normalize('NFD')]));
const ipaSegments = new Set([...IPA_CHARACTERS.consonants + IPA_CHARACTERS.vowels + 'ɝg']);
export const isIpaCharacter = (c) => [...c.normalize('NFD')].every((part) => ipaSet.has(part));
export const hasIpaSegment = (body) => [...body.normalize('NFD')].some((c) => ipaSegments.has(c));

export function validIpaTies(body) {
  const characters = [...body.normalize('NFD')];
  let preceding;
  for (const [index, c] of characters.entries()) {
    if (c === '\u035c' || c === '\u0361') {
      if (!ipaSegments.has(preceding) || !ipaSegments.has(characters[index + 1])) return false;
    } else if (!/\p{M}/u.test(c)) preceding = c;
  }
  return true;
}

export function ipaCharacterPrompt() {
  return `## Allowed IPA characters\nInventory: ${JSON.stringify(IPA_CHARACTERS)}\n` +
    'Combining entries are Unicode code points attached to segments; canonically equivalent precomposed characters are allowed. ' +
    'Use only this inventory inside one pair of /slashes/. Include at least one consonant or vowel. ' +
    'Do not use romanization, hyphens, digits, brackets, or unrelated letters. ' +
    'Affricates use separate segments and optional tie bars, not superseded ligatures. ' +
    'Tie bars must join two consonant or vowel segments without intervening spaces or stress marks. ' +
    'Tone diacritics mark tone, not vowel length; use ː for length. In Arabic use x or χ as appropriate, never romanization ḫ, and aː for a long a, never romanization ā. ' +
    'Use only symbols appropriate to the source language and dialect; this inventory does not imply that every symbol is suitable for every language.\n';
}

// Primary native exemplars from Unicode CLDR, plus upper-case equivalents and
// their canonical decompositions. These are guide alphabets, not word lists.
// https://github.com/unicode-org/cldr-json/tree/main/cldr-json/cldr-misc-full/main
const ALPHABETS = {
  en: ['Latin', 'abcdefghijklmnopqrstuvwxyz'],
  es: ['Latin', 'abcdefghijklmnopqrstuvwxyzáéíñóúü'],
  fr: ['Latin', 'abcdefghijklmnopqrstuvwxyzàâæçéèêëîïôœùûüÿ'],
  de: ['Latin', 'abcdefghijklmnopqrstuvwxyzäöüßẞ'],
  pt: ['Latin', 'abcdefghijklmnopqrstuvwxyzáàâãçéêíóòôõú'],
  ru: ['Cyrillic', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя\u0301'],
  ar: ['Arabic', 'ًٌٍَُِّْٰءأؤإئاآبةتثجحخدذرزسشصضطظعغفقكلمنهوىي'],
};
const PUNCTUATION = " '-’‐‑";
const phoneticModifiers = new Set([...IPA_CHARACTERS.modifiers + IPA_CHARACTERS.additional]
  .filter((c) => !/\p{M}/u.test(c)));
const respellingPolicies = new Map();

function rangesFor(characters) {
  const ranges = [];
  for (const point of [...new Set([...characters].map((c) => c.codePointAt(0)))].sort((a, b) => a - b)) {
    if (ranges.length && ranges.at(-1)[1] + 1 === point) ranges.at(-1)[1] = point;
    else ranges.push([point, point]);
  }
  return ranges;
}
const hex = (point) => point.toString(16).toUpperCase().padStart(4, '0');

export function respellingCharacters(policy) {
  if (!policy?.script) throw new Error(`No script policy for target ${policy?.code}; configure languagePolicies in YAML`);
  let language;
  try { language = new Intl.Locale(policy.code).language; } catch { language = policy.code; }
  const key = JSON.stringify([language, policy.script]);
  if (respellingPolicies.has(key)) return respellingPolicies.get(key);
  const native = ALPHABETS[language];
  const characters = new Set(PUNCTUATION);
  const add = (c) => { for (const part of [c, ...c.normalize('NFD')]) characters.add(part); };
  if (native?.[0] === policy.script) {
    for (const c of native[1] + native[1].toUpperCase()) add(c);
  } else {
    // Large inventories (especially Han) are injected as exact compact ranges.
    // Unknown languages honor the configured script rather than guessing an alphabet.
    const scripts = policy.script === 'Japanese' ? ['Hiragana', 'Katakana', 'Han'] : [policy.script];
    const script = new RegExp(scripts.map((s) => `\\p{Script_Extensions=${s}}`).join('|'), 'u');
    for (let point = 0; point <= 0x10ffff; point++) {
      const c = String.fromCodePoint(point);
      if (/[\p{L}\p{M}]/u.test(c) && script.test(c) &&
          !/[\u0250-\u02af\u1d00-\u1dbf\p{Default_Ignorable_Code_Point}]/u.test(c) &&
          !phoneticModifiers.has(c)) add(c);
    }
  }
  const ranges = rangesFor(characters);
  const escaped = ranges.map(([a, b]) => `\\u{${hex(a)}}${a === b ? '' : `-\\u{${hex(b)}}`}`).join('');
  const allowed = new RegExp(`^[${escaped}]$`, 'u');
  const description = characters.size <= 256 ? { characters: [...characters].join('') } :
    { unicodeRanges: ranges.map(([a, b]) => `U+${hex(a)}${a === b ? '' : `–U+${hex(b)}`}`) };
  const result = { allowed, description, native: native?.[0] === policy.script };
  respellingPolicies.set(key, result);
  return result;
}

export function respellingCharacterPrompt(target) {
  const { description, native } = respellingCharacters(target);
  return `## Allowed respelling characters for ${target.code}\n` +
    `Target character inventory (data): ${JSON.stringify({ code: target.code, script: target.script, ...description })}\n` +
    `${native ? 'Use the target language alphabet above' : 'Use ordinary target-language spelling within the configured script inventory above'}; ` +
    'combining marks must attach to a letter. Canonically equivalent precomposed and decomposed spellings are allowed. ' +
    'Include at least one native letter. Only the listed spaces, apostrophes, and hyphens are permitted punctuation. ' +
    'Do not use IPA symbols, other scripts, digits, brackets, slashes, or invisible formatting characters.\n';
}
