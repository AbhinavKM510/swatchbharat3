/**
 * Dataset loading, stratified splitting and preprocessing for the Pima Indians
 * Diabetes dataset — extracted so that EVERY model in this project trains on and is
 * measured against byte-identical data.
 *
 * Why this file exists
 * --------------------
 * `ml/train_model.mjs` (the shipped CART) does its own loading and splitting inline.
 * When the neural models were added there was a choice: reimplement the split in
 * Python, or prepare it once in Node and let every trainer read the same arrays.
 *
 * Reimplementing was rejected. The split is driven by mulberry32 (see
 * `makeRng` in ./cart.mjs) and the imputation medians are computed on the TRAIN
 * SPLIT ONLY. Reproducing JavaScript's `Math.imul` semantics and `Number.toFixed`
 * rounding in Python to get the same 614/154 rows is possible but is exactly the
 * kind of subtle, silent, off-by-a-few-rows divergence that would make a
 * "PyTorch beats CART" claim meaningless. If two models are compared on even
 * slightly different held-out sets, the comparison is decoration.
 *
 * So: preprocessing happens here, once, in Node, and is written to
 * `ml/export/dataset_split.json` by `ml/prepare_dataset.mjs`.
 *
 * VERIFICATION: this module duplicates logic that already exists inline in
 * `ml/train_model.mjs`. That duplication is not taken on trust —
 * `ml/prepare_dataset.mjs` asserts that the medians and the family-history
 * threshold produced here are identical to the ones recorded in the committed
 * `ml/export/model_metadata.json`. If the two ever drift, preparation fails loudly
 * rather than quietly training the neural nets on different data than the tree.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRng, shuffleInPlace, median } from './cart.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ML_ROOT = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(ML_ROOT, '..');
export const DATA_PATH = path.join(ML_ROOT, 'data', 'pima_indians_diabetes.csv');

/** Kept in lockstep with ml/train_model.mjs. */
export const RANDOM_SEED = 42;
export const TEST_FRACTION = 0.2;
export const RISK_BANDS = { high: 0.6, moderate: 0.3 };

/**
 * Columns where a recorded 0 is physiologically impossible and therefore means
 * "not measured". Imputed with the TRAIN-split median — never the full-dataset
 * median, which would leak held-out information into training.
 */
export const ZERO_MEANS_MISSING = [
  'Glucose',
  'BloodPressure',
  'SkinThickness',
  'Insulin',
  'BMI',
];

/**
 * Model feature order. Names are the app's field names rather than the dataset's,
 * so every exported artefact speaks the same language as the form feeding it.
 * MUST match FEATURE_ORDER in shared/risk/decision_tree_rules.js.
 */
export const FEATURES = [
  { name: 'glucose', column: 'Glucose' },
  { name: 'diastolicBp', column: 'BloodPressure' },
  { name: 'bmi', column: 'BMI' },
  { name: 'age', column: 'Age' },
  { name: 'pregnancies', column: 'Pregnancies' },
  { name: 'familyHistory', column: 'DiabetesPedigreeFunction' },
  { name: 'skinThickness', column: 'SkinThickness' },
  { name: 'insulin', column: 'Insulin' },
];

export const FEATURE_NAMES = FEATURES.map((f) => f.name);

export function loadCsv(filePath = DATA_PATH) {
  const text = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').trim();
  const [headerLine, ...rows] = text.split('\n');
  const headers = headerLine.split(',').map((h) => h.trim());
  return rows
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const cells = line.split(',');
      const record = {};
      headers.forEach((h, i) => {
        record[h] = Number(cells[i]);
      });
      return record;
    });
}

/**
 * Stratified train/test split. Positives and negatives are shuffled separately and
 * split at the same fraction, so the positive rate is preserved in both halves.
 *
 * The RNG instance is threaded through all four shuffles in a fixed order
 * (positives, negatives, train concat, test concat) because that is what
 * ml/train_model.mjs does; changing the order changes the split.
 */
export function stratifiedSplit(records, testFraction = TEST_FRACTION, seed = RANDOM_SEED) {
  const rng = makeRng(seed);
  const positives = records.filter((r) => r.Outcome === 1);
  const negatives = records.filter((r) => r.Outcome === 0);
  shuffleInPlace(positives, rng);
  shuffleInPlace(negatives, rng);

  const takeTest = (arr) => {
    const n = Math.round(arr.length * testFraction);
    return { test: arr.slice(0, n), train: arr.slice(n) };
  };

  const p = takeTest(positives);
  const n = takeTest(negatives);

  const train = shuffleInPlace([...p.train, ...n.train], rng);
  const test = shuffleInPlace([...p.test, ...n.test], rng);
  return { train, test };
}

/**
 * Loads, splits and vectorises the dataset.
 *
 * @returns {{
 *   records: object[],
 *   featureNames: string[],
 *   train: {X: number[][], y: number[]},
 *   test: {X: number[][], y: number[]},
 *   imputationMedians: Record<string, number>,
 *   pedigreeThreshold: number,
 *   missingCounts: Record<string, number>,
 *   positiveRate: number
 * }}
 */
export function prepareDataset({
  dataPath = DATA_PATH,
  seed = RANDOM_SEED,
  testFraction = TEST_FRACTION,
} = {}) {
  if (!fs.existsSync(dataPath)) {
    throw new Error(`Dataset not found at ${dataPath}. See ml/README.md for the download command.`);
  }

  const records = loadCsv(dataPath);
  const { train, test } = stratifiedSplit(records, testFraction, seed);

  const imputationMedians = {};
  for (const column of ZERO_MEANS_MISSING) {
    const observed = train.map((r) => r[column]).filter((v) => v > 0);
    imputationMedians[column] = Number(median(observed).toFixed(2));
  }

  const missingCounts = {};
  for (const column of ZERO_MEANS_MISSING) {
    missingCounts[column] = records.filter((r) => r[column] === 0).length;
  }

  /**
   * DiabetesPedigreeFunction is a continuous score synthesised from a family tree.
   * A health worker in the field cannot compute it, so the form asks a single
   * yes/no question instead. The feature is therefore binarised AT TRAINING TIME
   * at the train-split median: training and serving see the same feature
   * definition, and there is no train/serve skew from inventing a pedigree score
   * out of a yes/no answer at prediction time.
   */
  const pedigreeThreshold = Number(
    median(train.map((r) => r.DiabetesPedigreeFunction)).toFixed(4),
  );

  const toFeatureVector = (record) =>
    FEATURES.map(({ name, column }) => {
      if (name === 'familyHistory') {
        return record.DiabetesPedigreeFunction >= pedigreeThreshold ? 1 : 0;
      }
      const raw = record[column];
      if (ZERO_MEANS_MISSING.includes(column) && (raw === 0 || Number.isNaN(raw))) {
        return imputationMedians[column];
      }
      return raw;
    });

  return {
    records,
    featureNames: FEATURE_NAMES,
    train: { X: train.map(toFeatureVector), y: train.map((r) => r.Outcome) },
    test: { X: test.map(toFeatureVector), y: test.map((r) => r.Outcome) },
    imputationMedians,
    pedigreeThreshold,
    missingCounts,
    positiveRate: Number(
      (records.filter((r) => r.Outcome === 1).length / records.length).toFixed(4),
    ),
  };
}

/** Column-wise mean and (population) standard deviation, computed on the train split. */
export function standardisationStats(X) {
  const nFeatures = X[0].length;
  const mean = new Array(nFeatures).fill(0);
  const std = new Array(nFeatures).fill(0);

  for (const row of X) {
    for (let j = 0; j < nFeatures; j += 1) mean[j] += row[j];
  }
  for (let j = 0; j < nFeatures; j += 1) mean[j] /= X.length;

  for (const row of X) {
    for (let j = 0; j < nFeatures; j += 1) {
      const d = row[j] - mean[j];
      std[j] += d * d;
    }
  }
  for (let j = 0; j < nFeatures; j += 1) {
    // Guard against a constant column producing a divide-by-zero at serving time.
    std[j] = Math.sqrt(std[j] / X.length) || 1;
  }

  return { mean, std };
}

/** Column-wise median of a feature matrix — the baseline for integrated gradients. */
export function columnMedians(X) {
  const nFeatures = X[0].length;
  const out = new Array(nFeatures);
  for (let j = 0; j < nFeatures; j += 1) {
    out[j] = median(X.map((row) => row[j]));
  }
  return out;
}

/** Maps a probability to a risk band using the shared cut-offs. */
export function bandOf(probability, bands = RISK_BANDS) {
  if (probability >= bands.high) return 'HIGH';
  if (probability >= bands.moderate) return 'MODERATE';
  return 'LOW';
}

/**
 * Held-out band spread: how many patients land in each band and how many of those
 * really are diabetic. A band holding almost nobody is not a band — this is the
 * check that rejected scikit-learn's tree (1.3% of patients in MODERATE) and it is
 * applied to the neural models on exactly the same terms.
 */
export function bandSummary(yTrue, probabilities, bands = RISK_BANDS) {
  const counts = { LOW: [0, 0], MODERATE: [0, 0], HIGH: [0, 0] };
  probabilities.forEach((p, i) => {
    const band = bandOf(p, bands);
    counts[band][1] += 1;
    if (yTrue[i] === 1) counts[band][0] += 1;
  });
  return Object.fromEntries(
    Object.entries(counts).map(([band, [pos, total]]) => [
      band,
      {
        patients: total,
        actualDiabetic: pos,
        actualDiabeticRate: total ? Number((pos / total).toFixed(4)) : null,
        share: Number((total / probabilities.length).toFixed(4)),
      },
    ]),
  );
}
