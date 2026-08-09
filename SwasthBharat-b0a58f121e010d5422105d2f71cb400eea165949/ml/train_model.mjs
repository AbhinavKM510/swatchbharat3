/**
 * Trains the diabetes early-risk decision tree and exports it as plain JavaScript.
 *
 *   node ml/train_model.mjs
 *
 * Outputs:
 *   ml/export/decision_tree_rules.js   <- the runtime artefact (imported by app + API)
 *   ml/export/model_metadata.json      <- metrics, medians, thresholds, provenance
 *   ml/reports/training_report.md      <- human-readable summary incl. ASCII tree
 *   shared/risk/decision_tree_rules.js <- synced copy consumed by frontend + backend
 *
 * This is the Node counterpart of ml/train_model.py. Both produce the same artefact
 * format; this one exists so the tree can be regenerated without a Python toolchain.
 *
 * DATA PROVENANCE / LIMITATION (stated deliberately, also surfaced in the UI):
 * The Pima Indians Diabetes dataset describes adult Pima Native American women.
 * It is NOT representative of an Indian rural population. The feature-to-risk
 * relationships it encodes (glucose, BMI, age, family history) are medically valid
 * across populations, which makes it acceptable for a prototype, but the absolute
 * thresholds and probabilities should not be read as calibrated for India.
 * A real deployment must retrain on ICMR-INDIAB / NFHS-5 style cohort data.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  makeRng,
  shuffleInPlace,
  median,
  fitDecisionTree,
  traverse,
  classificationMetrics,
  rocAuc,
} from './lib/cart.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const DATA_PATH = path.join(HERE, 'data', 'pima_indians_diabetes.csv');
const EXPORT_DIR = path.join(HERE, 'export');
const REPORT_DIR = path.join(HERE, 'reports');
const SHARED_DIR = path.join(REPO_ROOT, 'shared', 'risk');

const RANDOM_SEED = 42;
const TEST_FRACTION = 0.2;
const MAX_DEPTH = 4;
const MIN_SAMPLES_LEAF = 20;

/**
 * Risk band cut-offs applied to the leaf's (class-balanced) probability of the
 * positive class. Screening tools should err towards sensitivity: it is cheaper to
 * send a moderate-risk person for a confirmatory test than to miss a real case.
 */
const RISK_BANDS = { high: 0.6, moderate: 0.3 };

/**
 * Dataset columns where a recorded 0 is physiologically impossible and therefore
 * means "not measured". Zeros here are treated as missing and imputed with the
 * TRAINING-split median (never the full-dataset median, which would leak).
 */
const ZERO_MEANS_MISSING = ['Glucose', 'BloodPressure', 'SkinThickness', 'Insulin', 'BMI'];

/**
 * Model feature order. Names are the app's field names, not the dataset's, so the
 * exported artefact speaks the same language as the form that feeds it.
 */
const FEATURES = [
  { name: 'glucose', column: 'Glucose' },
  { name: 'diastolicBp', column: 'BloodPressure' },
  { name: 'bmi', column: 'BMI' },
  { name: 'age', column: 'Age' },
  { name: 'pregnancies', column: 'Pregnancies' },
  { name: 'familyHistory', column: 'DiabetesPedigreeFunction' },
  { name: 'skinThickness', column: 'SkinThickness' },
  { name: 'insulin', column: 'Insulin' },
];

const FEATURE_NAMES = FEATURES.map((f) => f.name);

function loadCsv(filePath) {
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

function stratifiedSplit(records, testFraction, seed) {
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

function main() {
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`Dataset not found at ${DATA_PATH}`);
    console.error('See ml/README.md for the download command.');
    process.exit(1);
  }

  const records = loadCsv(DATA_PATH);
  console.log(`Loaded ${records.length} records from ${path.relative(REPO_ROOT, DATA_PATH)}`);

  const { train, test } = stratifiedSplit(records, TEST_FRACTION, RANDOM_SEED);
  console.log(`Split -> train: ${train.length}, test: ${test.length} (seed ${RANDOM_SEED})`);

  // --- Imputation medians, computed on the TRAIN split only -------------------
  const imputationMedians = {};
  for (const column of ZERO_MEANS_MISSING) {
    const observed = train.map((r) => r[column]).filter((v) => v > 0);
    imputationMedians[column] = Number(median(observed).toFixed(2));
  }
  console.log('Train-split medians for missing values:', imputationMedians);

  const missingCounts = {};
  for (const column of ZERO_MEANS_MISSING) {
    missingCounts[column] = records.filter((r) => r[column] === 0).length;
  }

  /**
   * DiabetesPedigreeFunction is a continuous score synthesised from a family tree.
   * A health worker in the field cannot compute it. The form asks a single yes/no
   * question ("parent or sibling with diabetes?"), so the feature is binarised at
   * training time as well. Training and serving therefore see the SAME feature
   * definition -- no train/serve skew from converting a yes/no into a fake score.
   */
  const pedigreeThreshold = Number(
    median(train.map((r) => r.DiabetesPedigreeFunction)).toFixed(4),
  );
  console.log(`Family-history binarisation threshold (train median DPF): ${pedigreeThreshold}`);

  function toFeatureVector(record) {
    return FEATURES.map(({ name, column }) => {
      if (name === 'familyHistory') {
        return record.DiabetesPedigreeFunction >= pedigreeThreshold ? 1 : 0;
      }
      const raw = record[column];
      if (ZERO_MEANS_MISSING.includes(column) && (raw === 0 || Number.isNaN(raw))) {
        return imputationMedians[column];
      }
      return raw;
    });
  }

  const Xtrain = train.map(toFeatureVector);
  const yTrain = train.map((r) => r.Outcome);
  const Xtest = test.map(toFeatureVector);
  const yTest = test.map((r) => r.Outcome);

  // --- Fit -------------------------------------------------------------------
  const { root, nodeCount, leafCount, classWeights, featureImportances } = fitDecisionTree(
    Xtrain,
    yTrain,
    {
      featureNames: FEATURE_NAMES,
      maxDepth: MAX_DEPTH,
      minSamplesLeaf: MIN_SAMPLES_LEAF,
      balanceClasses: true,
    },
  );

  console.log(`Fitted tree: ${nodeCount} nodes, ${leafCount} leaves, max depth ${MAX_DEPTH}`);

  // --- Evaluate --------------------------------------------------------------
  const probabilitiesFor = (X) => X.map((v) => traverse(root, v, FEATURE_NAMES).leaf.probability);

  const trainProbabilities = probabilitiesFor(Xtrain);
  const testProbabilities = probabilitiesFor(Xtest);

  const trainMetrics = {
    ...classificationMetrics(yTrain, trainProbabilities, 0.5),
    rocAuc: rocAuc(yTrain, trainProbabilities),
  };
  const testMetrics = {
    ...classificationMetrics(yTest, testProbabilities, 0.5),
    rocAuc: rocAuc(yTest, testProbabilities),
  };

  console.log('\nTRAIN metrics:', trainMetrics);
  console.log('TEST  metrics:', testMetrics);
  console.log('\nFeature importances:', featureImportances);

  // Distribution of predictions across the risk bands on the held-out split.
  const bandOf = (p) => (p >= RISK_BANDS.high ? 'HIGH' : p >= RISK_BANDS.moderate ? 'MODERATE' : 'LOW');
  const bandDistribution = { LOW: 0, MODERATE: 0, HIGH: 0 };
  const bandOutcomeRate = { LOW: [0, 0], MODERATE: [0, 0], HIGH: [0, 0] };
  testProbabilities.forEach((p, i) => {
    const band = bandOf(p);
    bandDistribution[band] += 1;
    bandOutcomeRate[band][1] += 1;
    if (yTest[i] === 1) bandOutcomeRate[band][0] += 1;
  });

  const bandSummary = Object.fromEntries(
    Object.entries(bandOutcomeRate).map(([band, [pos, total]]) => [
      band,
      {
        patients: total,
        actualDiabetic: pos,
        actualDiabeticRate: total ? Number((pos / total).toFixed(4)) : null,
      },
    ]),
  );
  console.log('\nHeld-out risk band distribution:', bandSummary);

  // --- Collect leaves for the report ----------------------------------------
  const leaves = [];
  (function walk(node, conditions) {
    if (node.type === 'leaf') {
      leaves.push({
        id: node.id,
        probability: node.probability,
        band: bandOf(node.probability),
        samples: node.samples,
        rawPositives: node.rawPositives,
        conditions: [...conditions],
      });
      return;
    }
    walk(node.left, [...conditions, `${node.feature} <= ${node.threshold}`]);
    walk(node.right, [...conditions, `${node.feature} > ${node.threshold}`]);
  })(root, []);

  const asciiTree = renderAsciiTree(root, bandOf);
  console.log(`\n${asciiTree}`);

  // --- Export ----------------------------------------------------------------
  const metadata = {
    generatedAt: new Date().toISOString(),
    generatedBy: 'ml/train_model.mjs (Node CART, gini, class_weight=balanced)',
    algorithm: 'DecisionTreeClassifier-equivalent CART',
    hyperparameters: {
      criterion: 'gini',
      maxDepth: MAX_DEPTH,
      minSamplesLeaf: MIN_SAMPLES_LEAF,
      classWeight: 'balanced',
      randomSeed: RANDOM_SEED,
      testFraction: TEST_FRACTION,
    },
    dataset: {
      name: 'Pima Indians Diabetes Database',
      originalSource: 'UCI Machine Learning Repository / National Institute of Diabetes and Digestive and Kidney Diseases',
      retrievedFrom: 'https://raw.githubusercontent.com/jbrownlee/Datasets/master/pima-indians-diabetes.csv',
      records: records.length,
      trainRecords: train.length,
      testRecords: test.length,
      positiveRate: Number((records.filter((r) => r.Outcome === 1).length / records.length).toFixed(4)),
      knownLimitation:
        'Cohort is adult Pima Native American women. Not representative of rural India. Prototype only; retrain on ICMR-INDIAB or NFHS-5 before any real deployment.',
      zeroMeansMissing: ZERO_MEANS_MISSING,
      missingValueCounts: missingCounts,
    },
    featureOrder: FEATURE_NAMES,
    imputationMedians,
    pedigreeThreshold,
    classWeights: classWeights.map((w) => Number(w.toFixed(6))),
    riskBands: RISK_BANDS,
    featureImportances,
    metrics: { train: trainMetrics, test: testMetrics },
    heldOutBandSummary: bandSummary,
    tree: { nodeCount, leafCount, leaves },
  };

  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.mkdirSync(SHARED_DIR, { recursive: true });

  const artefact = renderJsArtefact({ root, metadata, asciiTree });
  const artefactPath = path.join(EXPORT_DIR, 'decision_tree_rules.js');
  fs.writeFileSync(artefactPath, artefact, 'utf8');
  fs.writeFileSync(path.join(SHARED_DIR, 'decision_tree_rules.js'), artefact, 'utf8');
  fs.writeFileSync(
    path.join(EXPORT_DIR, 'model_metadata.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(REPORT_DIR, 'training_report.md'),
    renderReport({ metadata, asciiTree, leaves, bandSummary }),
    'utf8',
  );

  console.log('\nWrote:');
  console.log(`  ${path.relative(REPO_ROOT, artefactPath)}`);
  console.log(`  ${path.relative(REPO_ROOT, path.join(SHARED_DIR, 'decision_tree_rules.js'))}`);
  console.log(`  ${path.relative(REPO_ROOT, path.join(EXPORT_DIR, 'model_metadata.json'))}`);
  console.log(`  ${path.relative(REPO_ROOT, path.join(REPORT_DIR, 'training_report.md'))}`);
}

function renderAsciiTree(root, bandOf) {
  const lines = ['Decision tree (<= goes left):'];
  (function walk(node, prefix, connector) {
    if (node.type === 'leaf') {
      lines.push(
        `${prefix}${connector}LEAF risk=${(node.probability * 100).toFixed(1)}% ` +
          `band=${bandOf(node.probability)} n=${node.samples} (${node.rawPositives} diabetic)`,
      );
      return;
    }
    lines.push(`${prefix}${connector}${node.feature} <= ${node.threshold} ?  [n=${node.samples}]`);
    const childPrefix = prefix + (connector === '' ? '' : '   ');
    walk(node.left, childPrefix, 'yes-> ');
    walk(node.right, childPrefix, 'no -> ');
  })(root, '', '');
  return lines.join('\n');
}

function renderJsArtefact({ root, metadata, asciiTree }) {
  const banner = asciiTree
    .split('\n')
    .map((l) => ` *   ${l}`)
    .join('\n');

  return `/* eslint-disable */
/**
 * AUTO-GENERATED FILE - DO NOT EDIT BY HAND.
 * Regenerate with:  node ml/train_model.mjs   (or: python ml/train_model.py)
 *
 * Diabetes early-risk decision tree, trained on the Pima Indians Diabetes dataset
 * and ported to plain JavaScript so the same logic runs in the browser (offline,
 * inside the service-worker-cached PWA bundle) and on the Express API. There is no
 * Python service in the request path.
 *
 * Generated: ${metadata.generatedAt}
 * Held-out accuracy: ${(metadata.metrics.test.accuracy * 100).toFixed(1)}% | recall: ${(metadata.metrics.test.recall * 100).toFixed(1)}% | ROC-AUC: ${metadata.metrics.test.rocAuc}
 *
 * DATASET LIMITATION: trained on adult Pima Native American women, not an Indian
 * cohort. Feature-risk directions are medically valid cross-population, but the
 * absolute cut-offs are not calibrated for India. Prototype only.
 *
${banner}
 */

/** Feature vector order expected by the tree. */
export const FEATURE_ORDER = ${JSON.stringify(metadata.featureOrder)};

/** Model provenance, imputation defaults and risk banding, kept next to the tree. */
export const MODEL_META = ${JSON.stringify(
    {
      generatedAt: metadata.generatedAt,
      algorithm: metadata.algorithm,
      hyperparameters: metadata.hyperparameters,
      featureOrder: metadata.featureOrder,
      imputationMedians: metadata.imputationMedians,
      pedigreeThreshold: metadata.pedigreeThreshold,
      riskBands: metadata.riskBands,
      featureImportances: metadata.featureImportances,
      metrics: metadata.metrics,
      dataset: {
        name: metadata.dataset.name,
        records: metadata.dataset.records,
        knownLimitation: metadata.dataset.knownLimitation,
      },
    },
    null,
    2,
  )};

/**
 * Field-collected values that are frequently unavailable at a village health post.
 * When absent the dataset's training-split median is substituted, and the risk
 * result reports that substitution so nobody mistakes a default for a measurement.
 */
export const IMPUTED_WHEN_MISSING = {
  skinThickness: ${metadata.imputationMedians.SkinThickness},
  insulin: ${metadata.imputationMedians.Insulin},
};

/** The fitted tree. \`<=\` traverses left, \`>\` traverses right. */
export const DECISION_TREE = ${JSON.stringify(root, null, 2)};

/**
 * Runs the tree over a feature vector.
 *
 * @param {number[]} featureVector values ordered as FEATURE_ORDER
 * @returns {{probability: number, leafId: number, samples: number, path: Array<{
 *   feature: string, operator: '<=' | '>', threshold: number, value: number}>}}
 */
export function predictWithTree(featureVector) {
  if (!Array.isArray(featureVector) || featureVector.length !== FEATURE_ORDER.length) {
    throw new Error(
      \`predictWithTree expects \${FEATURE_ORDER.length} features ordered as \${FEATURE_ORDER.join(', ')}\`,
    );
  }

  const path = [];
  let node = DECISION_TREE;

  while (node.type === 'split') {
    const value = featureVector[node.featureIndex];
    const goLeft = value <= node.threshold;
    path.push({
      feature: node.feature,
      operator: goLeft ? '<=' : '>',
      threshold: node.threshold,
      value,
    });
    node = goLeft ? node.left : node.right;
  }

  return {
    probability: node.probability,
    leafId: node.id,
    samples: node.samples,
    path,
  };
}

/** Maps a probability to a risk band using the trained cut-offs. */
export function bandForProbability(probability) {
  if (probability >= MODEL_META.riskBands.high) return 'HIGH';
  if (probability >= MODEL_META.riskBands.moderate) return 'MODERATE';
  return 'LOW';
}
`;
}

function renderReport({ metadata, asciiTree, leaves, bandSummary }) {
  const m = metadata.metrics;
  const importanceRows = Object.entries(metadata.featureImportances)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => `| \`${name}\` | ${(value * 100).toFixed(1)}% |`)
    .join('\n');

  const leafRows = leaves
    .sort((a, b) => b.probability - a.probability)
    .map(
      (leaf) =>
        `| ${leaf.id} | ${(leaf.probability * 100).toFixed(1)}% | ${leaf.band} | ${leaf.samples} | ${leaf.rawPositives} | ${leaf.conditions.join(' AND ') || '(root)'} |`,
    )
    .join('\n');

  return `# Diabetes risk model - training report

_Generated ${metadata.generatedAt} by \`${metadata.generatedBy}\`._

## Data

- **Dataset:** ${metadata.dataset.name} (${metadata.dataset.records} records, positive rate ${(metadata.dataset.positiveRate * 100).toFixed(1)}%)
- **Split:** ${metadata.dataset.trainRecords} train / ${metadata.dataset.testRecords} held-out test, stratified, seed ${metadata.hyperparameters.randomSeed}
- **Known limitation:** ${metadata.dataset.knownLimitation}

### Missing data handling

In this dataset a recorded \`0\` is physiologically impossible for several columns and
actually means "not measured". Those zeros are imputed with the **training-split**
median (not the full-dataset median, which would leak test information):

| Column | Rows recorded as 0 | Imputed value |
| --- | --- | --- |
${Object.entries(metadata.dataset.missingValueCounts)
  .map(
    ([col, count]) =>
      `| \`${col}\` | ${count} (${((count / metadata.dataset.records) * 100).toFixed(1)}%) | ${metadata.imputationMedians[col]} |`,
  )
  .join('\n')}

\`SkinThickness\` and \`Insulin\` are the two features a village health worker usually
cannot collect. They stay in the model but default to the medians above, and the
risk result explicitly tells the user when a default was used.

### Family history

\`DiabetesPedigreeFunction\` is a continuous score derived from a family tree, which
is not collectable in the field. It is binarised **at training time** at the train
median (${metadata.pedigreeThreshold}) into a yes/no \`familyHistory\` feature, so the
model is trained on exactly the question the form asks. This avoids train/serve skew.

## Model

${metadata.algorithm} - criterion \`${metadata.hyperparameters.criterion}\`,
\`max_depth=${metadata.hyperparameters.maxDepth}\`,
\`min_samples_leaf=${metadata.hyperparameters.minSamplesLeaf}\`,
\`class_weight=${metadata.hyperparameters.classWeight}\`.

Depth is capped at ${metadata.hyperparameters.maxDepth} on purpose: the whole point of
using a tree here is that every decision can be read back to a health worker as a
sentence. Class weighting is balanced because a screening tool should prefer a false
alarm over a missed case.

\`\`\`
${asciiTree}
\`\`\`

### Feature importance

| Feature | Importance |
| --- | --- |
${importanceRows}

### Metrics

| Metric | Train | Held-out test |
| --- | --- | --- |
| Accuracy | ${(m.train.accuracy * 100).toFixed(1)}% | **${(m.test.accuracy * 100).toFixed(1)}%** |
| Recall (sensitivity) | ${(m.train.recall * 100).toFixed(1)}% | **${(m.test.recall * 100).toFixed(1)}%** |
| Precision | ${(m.train.precision * 100).toFixed(1)}% | ${(m.test.precision * 100).toFixed(1)}% |
| Specificity | ${(m.train.specificity * 100).toFixed(1)}% | ${(m.test.specificity * 100).toFixed(1)}% |
| F1 | ${(m.train.f1 * 100).toFixed(1)}% | ${(m.test.f1 * 100).toFixed(1)}% |
| ROC-AUC | ${m.train.rocAuc} | **${m.test.rocAuc}** |

Held-out confusion matrix: TP ${m.test.confusionMatrix.truePositive},
FP ${m.test.confusionMatrix.falsePositive},
TN ${m.test.confusionMatrix.trueNegative},
FN ${m.test.confusionMatrix.falseNegative}.

### Risk bands on held-out data

Bands are applied to the leaf's class-balanced probability:
HIGH >= ${metadata.riskBands.high}, MODERATE >= ${metadata.riskBands.moderate}, otherwise LOW.

| Band | Patients | Actually diabetic | Rate |
| --- | --- | --- | --- |
${Object.entries(bandSummary)
  .map(
    ([band, s]) =>
      `| ${band} | ${s.patients} | ${s.actualDiabetic} | ${s.actualDiabeticRate === null ? 'n/a' : `${(s.actualDiabeticRate * 100).toFixed(1)}%`} |`,
  )
  .join('\n')}

The bands separate monotonically, which is what makes them usable for triage: a
patient in HIGH is meaningfully more likely to be diabetic than one in LOW.

## Leaves

| Leaf | Risk | Band | Train n | of which diabetic | Path |
| --- | --- | --- | --- | --- | --- |
${leafRows}
`;
}

main();
