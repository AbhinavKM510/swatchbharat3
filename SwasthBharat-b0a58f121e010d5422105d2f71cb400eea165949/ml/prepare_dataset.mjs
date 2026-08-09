/**
 * Prepares the train/test split once, in Node, for every trainer to share.
 *
 *   node ml/prepare_dataset.mjs
 *
 * Output:
 *   ml/export/dataset_split.json   <- feature matrices, labels, medians, standardisation
 *
 * The neural trainers (ml/train_neural.py, ml/train_neural_tf.py) read this file
 * instead of doing their own split. That is deliberate: it means the PyTorch MLP, the
 * Keras MLP and the shipped CART are fitted on the same 614 rows and scored on the
 * same 154 held-out rows, so comparing them says something real.
 *
 * SELF-CHECK
 * ----------
 * This script duplicates the preprocessing that ml/train_model.mjs performs inline.
 * Rather than trusting that the duplicate is faithful, it asserts the results against
 * the committed ml/export/model_metadata.json — the metadata of the tree that is
 * actually shipped. Any drift in the split, the train-split medians or the
 * family-history threshold fails the run.
 *
 * Nothing here touches shared/risk/. It cannot change the live model.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ML_ROOT,
  REPO_ROOT,
  RANDOM_SEED,
  TEST_FRACTION,
  RISK_BANDS,
  ZERO_MEANS_MISSING,
  FEATURE_NAMES,
  prepareDataset,
  standardisationStats,
  columnMedians,
} from './lib/dataset.mjs';

const EXPORT_DIR = path.join(ML_ROOT, 'export');
const OUTPUT_PATH = path.join(EXPORT_DIR, 'dataset_split.json');
const TREE_METADATA_PATH = path.join(EXPORT_DIR, 'model_metadata.json');

let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

function main() {
  console.log('Preparing shared dataset split\n');

  const prepared = prepareDataset({ seed: RANDOM_SEED, testFraction: TEST_FRACTION });

  console.log(`Loaded ${prepared.records.length} records`);
  console.log(
    `Split -> train: ${prepared.train.X.length}, test: ${prepared.test.X.length} (seed ${RANDOM_SEED})`,
  );
  console.log('Train-split medians:', prepared.imputationMedians);
  console.log(`Family-history threshold (train median DPF): ${prepared.pedigreeThreshold}\n`);

  // --- Equivalence with the shipped tree's preprocessing ----------------------
  console.log('Verifying against the committed tree metadata:');

  if (!fs.existsSync(TREE_METADATA_PATH)) {
    console.error(`  FAIL  ${path.relative(REPO_ROOT, TREE_METADATA_PATH)} not found`);
    process.exit(1);
  }

  const tree = JSON.parse(fs.readFileSync(TREE_METADATA_PATH, 'utf8'));

  check(
    'feature order matches the shipped artefact',
    JSON.stringify(prepared.featureNames) === JSON.stringify(tree.featureOrder),
    `${JSON.stringify(prepared.featureNames)} vs ${JSON.stringify(tree.featureOrder)}`,
  );
  check(
    'train row count matches',
    prepared.train.X.length === tree.dataset.trainRecords,
    `${prepared.train.X.length} vs ${tree.dataset.trainRecords}`,
  );
  check(
    'held-out row count matches',
    prepared.test.X.length === tree.dataset.testRecords,
    `${prepared.test.X.length} vs ${tree.dataset.testRecords}`,
  );
  check(
    'train-split imputation medians match',
    JSON.stringify(prepared.imputationMedians) === JSON.stringify(tree.imputationMedians),
    `${JSON.stringify(prepared.imputationMedians)} vs ${JSON.stringify(tree.imputationMedians)}`,
  );
  check(
    'family-history binarisation threshold matches',
    prepared.pedigreeThreshold === tree.pedigreeThreshold,
    `${prepared.pedigreeThreshold} vs ${tree.pedigreeThreshold}`,
  );
  check(
    'positive rate matches',
    prepared.positiveRate === tree.dataset.positiveRate,
    `${prepared.positiveRate} vs ${tree.dataset.positiveRate}`,
  );

  if (failures > 0) {
    console.error(
      `\n${failures} check(s) failed. The shared split does NOT reproduce the shipped tree's\n` +
        'preprocessing, so any model trained from it would not be comparable to the tree.\n' +
        'Fix ml/lib/dataset.mjs before training anything.',
    );
    process.exit(1);
  }

  // --- Serialise --------------------------------------------------------------
  const standardisation = standardisationStats(prepared.train.X);
  const baseline = columnMedians(prepared.train.X);

  const positives = prepared.train.y.reduce((acc, v) => acc + v, 0);
  const negatives = prepared.train.y.length - positives;

  const payload = {
    generatedAt: new Date().toISOString(),
    generatedBy: 'ml/prepare_dataset.mjs',
    note:
      'Shared train/test split so the CART, PyTorch and Keras models are fitted and ' +
      'scored on identical rows. Regenerate with: node ml/prepare_dataset.mjs',
    randomSeed: RANDOM_SEED,
    testFraction: TEST_FRACTION,
    riskBands: RISK_BANDS,
    featureOrder: FEATURE_NAMES,
    zeroMeansMissing: ZERO_MEANS_MISSING,
    imputationMedians: prepared.imputationMedians,
    pedigreeThreshold: prepared.pedigreeThreshold,
    missingValueCounts: prepared.missingCounts,
    positiveRate: prepared.positiveRate,
    /** Baseline for integrated gradients: the median patient of the training split. */
    attributionBaseline: baseline,
    /** z-score parameters computed on the TRAIN split only. */
    standardisation,
    /**
     * scikit-learn's class_weight="balanced" formula, n / (2 * n_c). The tree uses
     * the same weighting, so the neural nets inherit the same
     * prefer-a-false-alarm-over-a-missed-case bias rather than a different one.
     */
    classWeights: [
      Number((prepared.train.y.length / (2 * Math.max(negatives, 1))).toFixed(6)),
      Number((prepared.train.y.length / (2 * Math.max(positives, 1))).toFixed(6)),
    ],
    train: prepared.train,
    test: prepared.test,
  };

  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log('\nStandardisation (train split):');
  FEATURE_NAMES.forEach((name, i) => {
    console.log(
      `  ${name.padEnd(14)} mean ${standardisation.mean[i].toFixed(4).padStart(10)}` +
        `   sd ${standardisation.std[i].toFixed(4).padStart(10)}` +
        `   median ${String(baseline[i]).padStart(8)}`,
    );
  });
  console.log(`\nClass weights [negative, positive]: ${JSON.stringify(payload.classWeights)}`);
  console.log(`\nWrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
  console.log('\nNext: python ml/train_neural.py');
}

main();
