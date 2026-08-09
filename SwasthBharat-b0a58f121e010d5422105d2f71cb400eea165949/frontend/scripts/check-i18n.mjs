/**
 * Audits the three locale files against each other. Read-only.
 *
 *   npm run check:i18n
 *
 * Checks:
 *   1. Every key in en.json exists in bn.json and hi.json.
 *   2. Neither has keys English does not.
 *   3. Every string's `{placeholder}` set matches English exactly.
 *   4. No value is an empty string.
 *   5. Bengali and Hindi values are not byte-identical copies of the English (a cheap
 *      but effective smoke test for keys that were added and never translated).
 *
 * Why this exists as a script rather than only as the dev-time runtime audit in
 * src/i18n/index.tsx: the runtime one logs to a console nobody is watching during a demo,
 * and it cannot catch a placeholder mismatch at all. A missing `{value}` in one language
 * means a number silently disappears from a sentence — in that language only, which is
 * exactly the bug that survives review.
 *
 * English is the reference because `TranslationKey` in src/i18n/index.tsx is derived from
 * en.json, so English is what the compiler already enforces.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES = path.resolve(HERE, '..', 'src', 'i18n', 'locales');
const REFERENCE = 'en';
const TRANSLATIONS = ['bn', 'hi'];

/**
 * Keys whose value is legitimately identical across all languages. Without an allowlist,
 * check 5 warns forever and stops being worth reading.
 *
 * Two categories qualify, and nothing else should be added without a reason:
 *   - strings that are nothing but placeholders, so there is no prose to translate
 *   - technical acronyms that are not translated in Bengali or Hindi either
 */
const IDENTICAL_ALLOWED = new Set([
  'meta.appName',
  'home.atPhc', // "{phc}"
  'dashboard.subtitle', // "{phc}"
  'dashboard.newAlertBody', // "{name}, {age} — {village}"
  'modelCard.metricRocAuc', // "ROC-AUC", untranslated in all three
]);

function collectLeafPaths(tree, prefix = '') {
  return Object.entries(tree).flatMap(([key, value]) => {
    const dotted = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [dotted] : collectLeafPaths(value, dotted);
  });
}

const readDeep = (tree, dotted) => dotted.split('.').reduce((node, key) => node?.[key], tree);
const placeholdersOf = (text) => [...(text.match(/\{(\w+)\}/g) ?? [])].sort().join(',');

const trees = {};
for (const language of [REFERENCE, ...TRANSLATIONS]) {
  const file = path.join(LOCALES, `${language}.json`);
  if (!fs.existsSync(file)) {
    console.error(`Missing locale file: ${file}`);
    process.exit(1);
  }
  trees[language] = JSON.parse(fs.readFileSync(file, 'utf8'));
}

const referenceKeys = collectLeafPaths(trees[REFERENCE]);
let failures = 0;

const fail = (message) => {
  failures += 1;
  console.error(`  FAIL  ${message}`);
};

console.log(`i18n audit against ${REFERENCE}.json (${referenceKeys.length} keys)\n`);

for (const language of TRANSLATIONS) {
  const keys = collectLeafPaths(trees[language]);
  const keySet = new Set(keys);
  const missing = referenceKeys.filter((key) => !keySet.has(key));
  const extra = keys.filter((key) => !referenceKeys.includes(key));

  console.log(`${language}.json — ${keys.length} keys`);

  if (missing.length === 0) console.log('  ok    no missing keys');
  else fail(`${missing.length} missing: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' ...' : ''}`);

  if (extra.length === 0) console.log('  ok    no extra keys');
  else fail(`${extra.length} extra: ${extra.slice(0, 12).join(', ')}${extra.length > 12 ? ' ...' : ''}`);

  const placeholderProblems = [];
  const emptyValues = [];
  const untranslated = [];

  for (const key of referenceKeys) {
    const reference = readDeep(trees[REFERENCE], key);
    const value = readDeep(trees[language], key);
    if (typeof value !== 'string') continue;

    if (value.trim() === '') emptyValues.push(key);
    if (placeholdersOf(value) !== placeholdersOf(reference)) {
      placeholderProblems.push(
        `${key} (en: ${placeholdersOf(reference) || 'none'}, ${language}: ${placeholdersOf(value) || 'none'})`,
      );
    }
    if (value === reference && !IDENTICAL_ALLOWED.has(key)) untranslated.push(key);
  }

  if (placeholderProblems.length === 0) console.log('  ok    placeholders match English');
  else fail(`${placeholderProblems.length} placeholder mismatch(es): ${placeholderProblems.slice(0, 8).join('; ')}`);

  if (emptyValues.length === 0) console.log('  ok    no empty values');
  else fail(`${emptyValues.length} empty: ${emptyValues.slice(0, 12).join(', ')}`);

  // A warning, not a failure: an identical string can be correct.
  if (untranslated.length === 0) {
    console.log('  ok    no values copied verbatim from English');
  } else {
    console.log(
      `  warn  ${untranslated.length} value(s) identical to English, check they are intentional:` +
        `\n          ${untranslated.slice(0, 12).join(', ')}${untranslated.length > 12 ? ' ...' : ''}`,
    );
  }

  console.log('');
}

if (failures > 0) {
  console.error(`${failures} check(s) FAILED.`);
  process.exit(1);
}

console.log(
  `Audit clean: ${referenceKeys.length} keys x ${1 + TRANSLATIONS.length} languages, ` +
    'no missing or extra keys, all placeholders match.',
);
