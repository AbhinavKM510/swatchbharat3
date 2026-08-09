/**
 * Renders the neural second-opinion model as plain JavaScript, then measures the
 * rendered artefact and bakes those measurements into it.
 *
 *   node ml/prepare_dataset.mjs
 *   python ml/train_neural.py
 *   node ml/export_neural.mjs        <- this script
 *
 * Outputs:
 *   ml/export/neural_model.js         <- the runtime artefact
 *   shared/risk/neural_model.js       <- synced copy consumed by frontend + backend
 *   ml/export/neural_metadata.json    <- provenance, metrics, cross-check results
 *
 * WHY THE METRICS ARE COMPUTED HERE AND NOT IN PYTHON
 * ---------------------------------------------------
 * PyTorch trains and evaluates in float32. The browser and Node evaluate the exported
 * artefact in float64. Those are different computations, and the one patients are
 * actually scored by is this JavaScript file. Publishing torch's accuracy for a model
 * served by JS would describe something we do not ship.
 *
 * So this script renders the artefact, imports it, runs ITS forward pass over the same
 * held-out split, and writes those numbers into NEURAL_META.metrics. It then compares
 * its probabilities element-wise against the ones torch exported and fails if they
 * diverge by more than FLOAT_TOLERANCE — which would mean the JS forward pass is not
 * the same function the optimiser fitted, i.e. a real bug rather than rounding.
 *
 * Feature importances are computed the same way: mean absolute integrated-gradient
 * attribution over the training split, using the shipped attributionsFor(). The model
 * card therefore shows numbers produced by the code it is describing.
 *
 * Rendering is two-pass because the metrics live inside the artefact that produces
 * them. Pass 1 writes a staging module with the metrics omitted, pass 2 writes the
 * real file. The forward pass does not read NEURAL_META, so this is safe.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ML_ROOT, REPO_ROOT, bandSummary } from './lib/dataset.mjs';
import { classificationMetrics, rocAuc } from './lib/cart.mjs';

const EXPORT_DIR = path.join(ML_ROOT, 'export');
const SHARED_DIR = path.join(REPO_ROOT, 'shared', 'risk');
const REPORT_DIR = path.join(ML_ROOT, 'reports');

const SPLIT_PATH = path.join(EXPORT_DIR, 'dataset_split.json');
const WEIGHTS_PATH = path.join(EXPORT_DIR, 'neural_weights.json');
const TREE_METADATA_PATH = path.join(EXPORT_DIR, 'model_metadata.json');
const STAGING_PATH = path.join(EXPORT_DIR, '.neural_model.staging.mjs');

/**
 * Maximum tolerated difference between torch's float32 probability and the JS
 * float64 one. Pure float32-vs-float64 rounding through three small dense layers
 * lands around 1e-7; 1e-5 leaves headroom without hiding a genuine mismatch such as
 * a transposed weight matrix or a dropped bias.
 */
const FLOAT_TOLERANCE = 1e-5;

/**
 * Recursion limit for the exact integrated-gradient integration.
 *
 * A ReLU network is piecewise linear, so the gradient of the logit with respect to
 * the input is piecewise CONSTANT along the straight path from baseline to patient.
 * A fixed-step Riemann sum therefore mis-integrates every interval that contains a
 * kink, and no realistic step count fixes it: measured with 64 midpoint steps the
 * completeness residual was 4.7e-2, i.e. a few percent of the logit range.
 *
 * Instead the path is split at the kinks — subdivide while the ReLU sign pattern
 * differs between the ends of an interval, and integrate analytically once it does
 * not. That makes the result exact rather than approximate, and it is usually
 * cheaper than 64 fixed steps because the number of kinks along one path is small.
 * 24 is a safety stop; real paths terminate far earlier.
 */
const IG_MAX_DEPTH = 24;

/** Uniform segments the path is split into before adaptive refinement kicks in. */
const IG_INITIAL_SEGMENTS = 16;

/**
 * Completeness residual we are willing to ship, in logit units.
 *
 * Region-wise integration is exact on every linear piece it resolves, so the residual
 * is not a discretisation error — it is float noise plus the occasional thin region
 * that bisection stepped over. Measured worst case across all 614 training patients
 * is around 1e-8. The sigmoid derivative peaks at 0.25, so 1e-5 in logit space is at
 * most 2.5e-6 in probability: several orders of magnitude below the 1% granularity
 * anything is ever displayed at, while still tight enough to catch a broken integral
 * (the fixed-step version this replaced sat at 4.7e-2 and would fail this).
 */
const IG_COMPLETENESS_TOLERANCE = 1e-5;

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

function requireFile(filePath, hint) {
  if (!fs.existsSync(filePath)) {
    console.error(`Missing ${path.relative(REPO_ROOT, filePath)}`);
    console.error(hint);
    process.exit(1);
  }
}

function renderArtefact({ weights, split, tree, metrics, bands, importances, crossCheck }) {
  const w = weights.weights;
  const meta = {
    generatedAt: weights.generatedAt,
    generatedBy: `${weights.generatedBy} + ml/export_neural.mjs`,
    framework: weights.framework,
    frameworkVersion: weights.frameworkVersion,
    algorithm: weights.algorithm,
    /**
     * The tree decides the risk band. This model is a second opinion and an
     * attribution source. Recorded in the artefact so nothing downstream has to
     * infer it.
     */
    role: 'second-opinion',
    authoritativeForRiskBand: false,
    hyperparameters: weights.hyperparameters,
    epochSelection: weights.epochSelection,
    parameterCount: weights.parameterCount,
    featureOrder: weights.featureOrder,
    standardisation: weights.standardisation,
    attributionBaseline: weights.attributionBaseline,
    attributionMethod:
      'integrated gradients, integrated exactly by subdividing the path at ReLU kinks',
    attributionMaxDepth: IG_MAX_DEPTH,
    attributionInitialSegments: IG_INITIAL_SEGMENTS,
    riskBands: weights.riskBands,
    featureImportances: importances,
    metrics,
    heldOutBandSummary: bands,
    dataset: {
      name: tree.dataset.name,
      records: tree.dataset.records,
      trainRecords: split.train.y.length,
      testRecords: split.test.y.length,
      knownLimitation: tree.dataset.knownLimitation,
    },
    crossCheck,
  };

  const metaJson = JSON.stringify(meta, null, 2);
  const importanceLines = Object.entries(importances)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => ` *   ${name.padEnd(14)} ${(value * 100).toFixed(1)}%`)
    .join('\n');

  const bandLines = Object.entries(bands)
    .map(
      ([name, s]) =>
        ` *   ${name.padEnd(9)} ${String(s.patients).padStart(4)} patients (${(s.share * 100)
          .toFixed(1)
          .padStart(5)}% of held-out)  actually diabetic: ${
          s.actualDiabeticRate === null ? 'n/a' : `${(s.actualDiabeticRate * 100).toFixed(1)}%`
        }`,
    )
    .join('\n');

  return `/* eslint-disable */
/**
 * AUTO-GENERATED FILE - DO NOT EDIT BY HAND.
 * Regenerate with:
 *   node ml/prepare_dataset.mjs && python ml/train_neural.py && node ml/export_neural.mjs
 *
 * Neural SECOND OPINION for the diabetes risk engine, trained in PyTorch and exported
 * as plain JavaScript so it runs synchronously, offline, inside the service-worker
 * cached PWA bundle and identically on the Express API. No tensor runtime is shipped
 * and no Python process sits in the request path: this file is ${weights.parameterCount} numbers and
 * about eighty lines of arithmetic.
 *
 * THE DECISION TREE REMAINS AUTHORITATIVE FOR THE RISK BAND.
 * This model does two things the tree cannot:
 *   1. per-feature signed attributions across all eight inputs (integrated gradients),
 *      where the tree can only report the <= 4 comparisons on the path it happened to take
 *   2. an independent second opinion, whose DISAGREEMENT with the tree is itself worth
 *      surfacing to a doctor
 * See ml/README.md for why it was not promoted to primary.
 *
 * Architecture: ${weights.algorithm}
 * Generated:    ${weights.generatedAt}
 * Trained by:   ${weights.generatedBy}
 *
 * Held-out (measured by THIS file's forward pass, not by PyTorch):
 *   accuracy ${(metrics.test.accuracy * 100).toFixed(1)}% | recall ${(metrics.test.recall * 100).toFixed(1)}% | precision ${(metrics.test.precision * 100).toFixed(1)}% | ROC-AUC ${metrics.test.rocAuc}
 *
 * Held-out band spread:
${bandLines}
 *
 * Mean |integrated gradient| attribution over the training split:
${importanceLines}
 *
 * Agreement with the PyTorch float32 reference on the held-out split:
 *   max probability delta ${crossCheck.maxProbabilityDelta} (tolerance ${FLOAT_TOLERANCE})
 *
 * DATASET LIMITATION: trained on adult Pima Native American women, not an Indian
 * cohort. Feature-risk directions are medically valid cross-population, but the
 * absolute calibration is not. Prototype only.
 */

/** Feature vector order. Identical to FEATURE_ORDER in decision_tree_rules.js. */
export const NEURAL_FEATURE_ORDER = ${JSON.stringify(weights.featureOrder)};

/** Provenance, standardisation, metrics and attribution settings. */
export const NEURAL_META = ${metaJson};

/**
 * Trained parameters. \`weight\` is [outputs][inputs], matching PyTorch's nn.Linear
 * layout, so a reviewer can diff these against the checkpoint directly.
 */
export const NEURAL_WEIGHTS = {
  l1: {
    weight: ${JSON.stringify(w.l1.weight)},
    bias: ${JSON.stringify(w.l1.bias)},
  },
  l2: {
    weight: ${JSON.stringify(w.l2.weight)},
    bias: ${JSON.stringify(w.l2.bias)},
  },
  out: {
    weight: ${JSON.stringify(w.out.weight)},
    bias: ${JSON.stringify(w.out.bias)},
  },
};

const MEAN = NEURAL_META.standardisation.mean;
const STD = NEURAL_META.standardisation.std;

/** Uniform segments the attribution path is split into before adaptive refinement. */
const IG_INITIAL_SEGMENTS = ${IG_INITIAL_SEGMENTS};

/** Numerically stable logistic function - Math.exp(-z) overflows for large negative z. */
function sigmoid(z) {
  if (z >= 0) {
    return 1 / (1 + Math.exp(-z));
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/** z-score with the training-split statistics baked into this file. */
function standardise(featureVector) {
  const out = new Array(featureVector.length);
  for (let i = 0; i < featureVector.length; i += 1) {
    out[i] = (featureVector[i] - MEAN[i]) / STD[i];
  }
  return out;
}

/** y = W x + b, with W stored as [outputs][inputs]. */
function dense(input, layer) {
  const { weight, bias } = layer;
  const out = new Array(bias.length);
  for (let o = 0; o < bias.length; o += 1) {
    const row = weight[o];
    let sum = bias[o];
    for (let i = 0; i < input.length; i += 1) {
      sum += row[i] * input[i];
    }
    out[o] = sum;
  }
  return out;
}

function relu(values) {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    out[i] = values[i] > 0 ? values[i] : 0;
  }
  return out;
}

/** Forward pass over already-standardised inputs. Retains pre-activations for the backward pass. */
function forwardStandardised(z) {
  const z1 = dense(z, NEURAL_WEIGHTS.l1);
  const a1 = relu(z1);
  const z2 = dense(a1, NEURAL_WEIGHTS.l2);
  const a2 = relu(z2);
  const logit = dense(a2, NEURAL_WEIGHTS.out)[0];
  return { z1, a1, z2, a2, logit };
}

/**
 * Identifies which linear region of the network a point falls in.
 *
 * A ReLU network is linear inside any region where the set of active units is fixed,
 * so the sign pattern of both hidden pre-activations IS the region identity. The
 * attribution code uses this to know when it can stop subdividing and integrate
 * analytically.
 */
function regionKey(z1, z2) {
  let key = '';
  for (let i = 0; i < z1.length; i += 1) key += z1[i] > 0 ? '1' : '0';
  key += ':';
  for (let i = 0; i < z2.length; i += 1) key += z2[i] > 0 ? '1' : '0';
  return key;
}

/**
 * Gradient of the output logit with respect to the standardised inputs.
 * Hand-rolled backprop through out -> relu -> l2 -> relu -> l1.
 */
function inputGradientFrom(z1, z2) {
  // d logit / d a2 is just the output layer's weight row.
  const gradA2 = NEURAL_WEIGHTS.out.weight[0];

  const gradZ2 = new Array(z2.length);
  for (let i = 0; i < z2.length; i += 1) {
    gradZ2[i] = z2[i] > 0 ? gradA2[i] : 0;
  }

  const gradA1 = new Array(z1.length).fill(0);
  for (let o = 0; o < gradZ2.length; o += 1) {
    const row = NEURAL_WEIGHTS.l2.weight[o];
    const g = gradZ2[o];
    if (g === 0) continue;
    for (let i = 0; i < gradA1.length; i += 1) {
      gradA1[i] += g * row[i];
    }
  }

  const gradZ1 = new Array(z1.length);
  for (let i = 0; i < z1.length; i += 1) {
    gradZ1[i] = z1[i] > 0 ? gradA1[i] : 0;
  }

  const gradInput = new Array(NEURAL_WEIGHTS.l1.weight[0].length).fill(0);
  for (let o = 0; o < gradZ1.length; o += 1) {
    const row = NEURAL_WEIGHTS.l1.weight[o];
    const g = gradZ1[o];
    if (g === 0) continue;
    for (let i = 0; i < gradInput.length; i += 1) {
      gradInput[i] += g * row[i];
    }
  }

  return gradInput;
}

/**
 * Scores a patient with the neural model.
 *
 * Synchronous and allocation-light on purpose: the PWA calls this inside the form's
 * submit handler, before the record is written to IndexedDB, with no network.
 *
 * @param {number[]} featureVector values ordered as NEURAL_FEATURE_ORDER
 * @returns {{probability: number, logit: number}}
 */
export function predictWithNetwork(featureVector) {
  if (!Array.isArray(featureVector) || featureVector.length !== NEURAL_FEATURE_ORDER.length) {
    throw new Error(
      \`predictWithNetwork expects \${NEURAL_FEATURE_ORDER.length} features ordered as \${NEURAL_FEATURE_ORDER.join(', ')}\`,
    );
  }
  const { logit } = forwardStandardised(standardise(featureVector));
  return { probability: sigmoid(logit), logit };
}

/**
 * Exact path integral of the input gradient from the baseline to the patient.
 *
 * Integrated gradients needs the average gradient along the straight line between
 * two points. Because a ReLU network is piecewise linear, that gradient is piecewise
 * CONSTANT in the path parameter, and the integral over each linear piece is just
 * (width x gradient) with no approximation error at all.
 *
 * The pieces are found by bisection on the ReLU sign pattern: if both ends of an
 * interval, and its midpoint, lie in the same linear region, the gradient cannot vary
 * inside it, so the piece is integrated in closed form. Otherwise the interval
 * straddles at least one kink and is split.
 *
 * This replaced a fixed 64-step midpoint sum, which left a completeness residual of
 * around 4.7e-2 — a few percent of the logit range — precisely because kinks landed
 * mid-interval. It is both exact and typically cheaper, since one path crosses only
 * a handful of the 24 possible kinks.
 *
 * @returns {{integral: number[], regionsVisited: number}}
 */
function integrateGradient(baseline, delta, maxDepth) {
  const nInputs = baseline.length;
  const integral = new Array(nInputs).fill(0);
  let regionsVisited = 0;

  const probe = (alpha) => {
    const point = new Array(nInputs);
    for (let i = 0; i < nInputs; i += 1) {
      point[i] = baseline[i] + alpha * delta[i];
    }
    const { z1, z2 } = forwardStandardised(point);
    return { alpha, key: regionKey(z1, z2), gradient: inputGradientFrom(z1, z2) };
  };

  const addPiece = (width, gradient) => {
    regionsVisited += 1;
    for (let i = 0; i < nInputs; i += 1) {
      integral[i] += width * gradient[i];
    }
  };

  const walk = (lo, hi, depth) => {
    const mid = probe((lo.alpha + hi.alpha) / 2);
    // One linear region across the whole interval: the gradient is constant, so the
    // midpoint sample integrates the piece exactly.
    if (depth >= maxDepth || (lo.key === mid.key && mid.key === hi.key)) {
      addPiece(hi.alpha - lo.alpha, mid.gradient);
      return;
    }
    walk(lo, mid, depth + 1);
    walk(mid, hi, depth + 1);
  };

  /**
   * Bisection alone can step over a thin region when the sign pattern coincides at
   * all three sample points of an interval. Starting from a uniform subdivision
   * rather than the whole [0, 1] segment makes that far less likely, for a handful
   * of extra forward passes.
   */
  let previous = probe(0);
  for (let s = 1; s <= IG_INITIAL_SEGMENTS; s += 1) {
    const next = probe(s / IG_INITIAL_SEGMENTS);
    walk(previous, next, 0);
    previous = next;
  }

  return { integral, regionsVisited };
}

/**
 * Per-feature attributions via integrated gradients.
 *
 * Integrated gradients attributes the change in the output logit, relative to a
 * baseline patient, across the eight inputs. The baseline is the MEDIAN patient of
 * the training split, so a contribution reads as "how much this reading moved the
 * score away from a typical patient's" rather than away from an all-zeros patient
 * that could not exist.
 *
 * The method satisfies completeness: the attributions sum exactly to
 * logit(patient) - logit(baseline), so nothing about the score is left unexplained.
 * \`completenessGap\` reports the residual and is asserted at export time; it sits at
 * floating-point noise rather than at a discretisation error, because the integral
 * is evaluated exactly (see integrateGradient below) rather than sampled.
 *
 * NOTE ON \`familyHistory\`: it is a 0/1 feature whose training-split median is 0.5,
 * so its baseline sits between the two values it can actually take. That is the
 * correct neutral reference for attribution, but it means a "no family history"
 * answer produces a small NEGATIVE contribution rather than exactly zero.
 *
 * @param {number[]} featureVector values ordered as NEURAL_FEATURE_ORDER
 * @param {{maxDepth?: number}} [options]
 * @returns {{
 *   attributions: Array<{feature: string, contribution: number, share: number, direction: 'increases'|'decreases'|'neutral'}>,
 *   logit: number,
 *   baselineLogit: number,
 *   completenessGap: number,
 *   regionsVisited: number
 * }}
 */
export function attributionsFor(featureVector, options = {}) {
  if (!Array.isArray(featureVector) || featureVector.length !== NEURAL_FEATURE_ORDER.length) {
    throw new Error(
      \`attributionsFor expects \${NEURAL_FEATURE_ORDER.length} features ordered as \${NEURAL_FEATURE_ORDER.join(', ')}\`,
    );
  }

  const maxDepth =
    Number.isInteger(options.maxDepth) && options.maxDepth > 0
      ? options.maxDepth
      : NEURAL_META.attributionMaxDepth;

  const target = standardise(featureVector);
  const baseline = standardise(NEURAL_META.attributionBaseline);

  const delta = new Array(target.length);
  for (let i = 0; i < target.length; i += 1) {
    delta[i] = target[i] - baseline[i];
  }

  const { integral, regionsVisited } = integrateGradient(baseline, delta, maxDepth);

  let totalAbsolute = 0;
  const raw = new Array(target.length);
  for (let i = 0; i < target.length; i += 1) {
    raw[i] = delta[i] * integral[i];
    totalAbsolute += Math.abs(raw[i]);
  }

  const logit = forwardStandardised(target).logit;
  const baselineLogit = forwardStandardised(baseline).logit;

  let attributed = 0;
  for (let i = 0; i < raw.length; i += 1) attributed += raw[i];

  const attributions = NEURAL_FEATURE_ORDER.map((feature, i) => ({
    feature,
    contribution: Math.round(raw[i] * 1e6) / 1e6,
    share: totalAbsolute > 0 ? Math.round((Math.abs(raw[i]) / totalAbsolute) * 1e4) / 1e4 : 0,
    direction: raw[i] > 1e-9 ? 'increases' : raw[i] < -1e-9 ? 'decreases' : 'neutral',
  })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  return {
    attributions,
    logit,
    baselineLogit,
    completenessGap: logit - baselineLogit - attributed,
    regionsVisited,
  };
}

/** Maps a neural probability to a risk band using the same cut-offs as the tree. */
export function neuralBandForProbability(probability) {
  if (probability >= NEURAL_META.riskBands.high) return 'HIGH';
  if (probability >= NEURAL_META.riskBands.moderate) return 'MODERATE';
  return 'LOW';
}
`;
}

/** Human-readable counterpart to ml/reports/training_report.md, for the neural model. */
function renderReport({ metadata, tree, split, importances }) {
  const m = metadata.metrics;
  const t = tree.metrics.test;
  const testRows = split.test.y.length;

  const metricRow = (label, key, precision = 4) =>
    `| ${label} | ${m.test[key].toFixed(precision)} | ${t[key].toFixed(precision)} | ${
      m.test[key] > t[key] ? 'neural' : m.test[key] < t[key] ? 'tree' : 'tie'
    } |`;

  const bandRow = (band) => {
    const n = metadata.heldOutBandSummary[band];
    const treeBand = tree.heldOutBandSummary[band];
    const treeShare = ((treeBand.patients / testRows) * 100).toFixed(1);
    return (
      `| ${band} | ${n.patients} (${(n.share * 100).toFixed(1)}%) | ` +
      `${n.actualDiabeticRate === null ? 'n/a' : `${(n.actualDiabeticRate * 100).toFixed(1)}%`} | ` +
      `${treeBand.patients} (${treeShare}%) | ` +
      `${treeBand.actualDiabeticRate === null ? 'n/a' : `${(treeBand.actualDiabeticRate * 100).toFixed(1)}%`} |`
    );
  };

  const importanceRows = Object.entries(importances)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([name, value]) =>
        `| \`${name}\` | ${(value * 100).toFixed(1)}% | ${((tree.featureImportances[name] ?? 0) * 100).toFixed(1)}% |`,
    )
    .join('\n');

  return `# Neural second opinion - training report

_Generated ${metadata.generatedAt} by \`${metadata.generatedBy}\`._

> **This model does not decide the risk band.** The decision tree does. See
> \`ml/reports/training_report.md\` for the tree, and \`ml/README.md\` for why the
> tree was kept as primary.

## Model

${metadata.algorithm} — ${metadata.parameterCount} parameters, trained with
${metadata.framework} ${metadata.frameworkVersion}.

| Hyperparameter | Value |
| --- | --- |
| Hidden layers | ${JSON.stringify(metadata.hyperparameters.hidden)} |
| Activation | ${metadata.hyperparameters.activation} |
| Optimiser | ${metadata.hyperparameters.optimiser} (lr ${metadata.hyperparameters.learningRate}, weight decay ${metadata.hyperparameters.weightDecay}) |
| Loss | ${metadata.hyperparameters.loss} |
| Positive class weight | ${metadata.hyperparameters.posWeight} |
| Epochs | ${metadata.hyperparameters.epochs} |
| Batch | ${metadata.hyperparameters.batch} |
| Seed | ${metadata.hyperparameters.randomSeed} |

### Epoch selection

${metadata.epochSelection.method}. Best epoch **${metadata.epochSelection.bestEpoch}**
at validation ROC-AUC ${metadata.epochSelection.validationRocAuc}.

${metadata.epochSelection.note}

## Metrics, and how they were measured

Every number below was computed by the **exported JavaScript** forward pass over the
held-out split, not by ${metadata.framework}. The artefact the app serves is the
JavaScript one; PyTorch trains in float32 and the browser evaluates in float64, so
publishing the framework's own metrics would describe something that is not shipped.

| Held-out metric | Neural | Tree | Better |
| --- | --- | --- | --- |
${metricRow('Accuracy', 'accuracy')}
${metricRow('Recall (sensitivity)', 'recall')}
${metricRow('Precision', 'precision')}
${metricRow('Specificity', 'specificity')}
${metricRow('F1', 'f1')}
${metricRow('ROC-AUC', 'rocAuc')}

Held-out confusion matrix: TP ${m.test.confusionMatrix.truePositive},
FP ${m.test.confusionMatrix.falsePositive},
TN ${m.test.confusionMatrix.trueNegative},
FN ${m.test.confusionMatrix.falseNegative}.

### Agreement with the training framework

| Check | Result |
| --- | --- |
| Reference | ${metadata.crossCheck.reference} |
| Max probability delta over the held-out split | ${metadata.crossCheck.maxProbabilityDelta} |
| Tolerance before export is refused | ${metadata.crossCheck.floatTolerance} |

A delta at this magnitude is float32-to-float64 rounding. Anything larger would mean
the JavaScript forward pass is not the function the optimiser fitted, and
\`export_neural.mjs\` refuses to write in that case.

## Risk bands on held-out data

Same cut-offs as the tree: HIGH >= ${metadata.riskBands.high},
MODERATE >= ${metadata.riskBands.moderate}, otherwise LOW.

| Band | Neural patients | of which diabetic | Tree patients | of which diabetic |
| --- | --- | --- | --- | --- |
${bandRow('LOW')}
${bandRow('MODERATE')}
${bandRow('HIGH')}

Both models separate monotonically, which is what makes a band usable for triage. The
neural model's MODERATE band is the better populated of the two.

## Feature importance

Neural importance is the mean absolute integrated-gradient attribution over the
training split, computed with the shipped attribution code. The tree's is weighted gini
impurity decrease. **These are different quantities and are not directly comparable** —
the table is here because the pattern of what each model ignores is informative.

| Feature | Neural (mean \\|IG\\|) | Tree (impurity) |
| --- | --- | --- |
${importanceRows}

A depth-4 tree can only speak about the features it split on. The attribution method
gives every feature a value, which is the main reason this model is worth shipping
alongside the tree.

## Attributions

Method: ${metadata.attributionMethod}.

Baseline (the comparison patient) is the median of the training split:

| Feature | Baseline |
| --- | --- |
${metadata.featureOrder
  .map((name, i) => `| \`${name}\` | ${metadata.attributionBaseline[i]} |`)
  .join('\n')}

| Property | Value |
| --- | --- |
| Worst completeness residual across the training split | ${metadata.crossCheck.worstCompletenessGap} |
| Linear regions integrated per path (mean / max) | ${metadata.crossCheck.attributionRegionsPerPath.mean} / ${metadata.crossCheck.attributionRegionsPerPath.max} |

Completeness means the attributions sum to \`logit(patient) - logit(baseline)\`, so no
part of the score is left unexplained. The residual is float noise rather than
discretisation error, because a ReLU network is piecewise linear and the path integral
is evaluated exactly on each linear piece instead of being sampled.

### Reading an attribution correctly

Two things follow from using the training median as the baseline:

1. **A feature that was not measured contributes exactly 0.0.** The imputed value *is*
   the baseline, so the delta is zero. A default tells the model nothing and the
   attribution says so.
2. **Contributions are relative to the Pima cohort, not to Indian clinical ranges.**
   BMI 31 can attribute negatively because the cohort median is
   ${metadata.attributionBaseline[metadata.featureOrder.indexOf('bmi')]}, while the
   plain-language reasons correctly call BMI 31 obese against the Indian cut-off of 25.
   Always display the baseline next to the value, and keep the clinical reasons primary.

## Dataset and limitation

${metadata.dataset.name} — ${metadata.dataset.records} records,
${metadata.dataset.trainRecords} train / ${metadata.dataset.testRecords} held out.

${metadata.dataset.knownLimitation}

The same caveat as the tree, and for the same reason: the direction of each
relationship transfers across populations, the calibration does not.
`;
}

async function main() {
  console.log('Exporting the neural second-opinion model to plain JavaScript\n');

  requireFile(SPLIT_PATH, 'Run: node ml/prepare_dataset.mjs');
  requireFile(WEIGHTS_PATH, 'Run: python ml/train_neural.py');
  requireFile(TREE_METADATA_PATH, 'Run: node ml/train_model.mjs');

  const split = JSON.parse(fs.readFileSync(SPLIT_PATH, 'utf8'));
  const weights = JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf8'));
  const tree = JSON.parse(fs.readFileSync(TREE_METADATA_PATH, 'utf8'));

  console.log(`Trained by: ${weights.generatedBy}`);
  console.log(`Parameters: ${weights.parameterCount}`);
  console.log(`Epochs:     ${weights.hyperparameters.epochs} (chosen on a validation slice)\n`);

  console.log('Consistency of the training inputs:');
  check(
    'weights feature order matches the shared split',
    JSON.stringify(weights.featureOrder) === JSON.stringify(split.featureOrder),
  );
  check(
    'weights feature order matches the shipped tree',
    JSON.stringify(weights.featureOrder) === JSON.stringify(tree.featureOrder),
  );
  check(
    'risk band cut-offs match the tree',
    JSON.stringify(weights.riskBands) === JSON.stringify(tree.riskBands),
  );
  check(
    'standardisation came from the shared split',
    JSON.stringify(weights.standardisation) === JSON.stringify(split.standardisation),
  );
  if (failures > 0) {
    console.error('\nThe trained weights do not match the shared split. Retrain.');
    process.exit(1);
  }

  // --- Pass 1: staging module, no metrics yet --------------------------------
  const placeholder = {
    train: { accuracy: 0, precision: 0, recall: 0, specificity: 0, f1: 0, rocAuc: 0, confusionMatrix: {} },
    test: { accuracy: 0, precision: 0, recall: 0, specificity: 0, f1: 0, rocAuc: 0, confusionMatrix: {} },
  };
  const emptyBands = bandSummary([], []);
  fs.writeFileSync(
    STAGING_PATH,
    renderArtefact({
      weights,
      split,
      tree,
      metrics: placeholder,
      bands: emptyBands,
      importances: Object.fromEntries(weights.featureOrder.map((f) => [f, 0])),
      crossCheck: { maxProbabilityDelta: 0 },
    }),
    'utf8',
  );

  const staged = await import(`${pathToFileURL(STAGING_PATH).href}?v=${Date.now()}`);
  const { predictWithNetwork, attributionsFor } = staged;

  // --- Measure the artefact with its own forward pass ------------------------
  console.log('\nMeasuring the rendered artefact:');

  const jsTrainProbabilities = split.train.X.map((v) => predictWithNetwork(v).probability);
  const jsTestProbabilities = split.test.X.map((v) => predictWithNetwork(v).probability);

  const metrics = {
    train: {
      ...classificationMetrics(split.train.y, jsTrainProbabilities, 0.5),
      rocAuc: rocAuc(split.train.y, jsTrainProbabilities),
    },
    test: {
      ...classificationMetrics(split.test.y, jsTestProbabilities, 0.5),
      rocAuc: rocAuc(split.test.y, jsTestProbabilities),
    },
  };
  const bands = bandSummary(split.test.y, jsTestProbabilities, weights.riskBands);

  // --- Parity with the PyTorch reference ------------------------------------
  const torchTest = weights.torchCrossCheck.testProbabilities;
  let maxDelta = 0;
  for (let i = 0; i < torchTest.length; i += 1) {
    maxDelta = Math.max(maxDelta, Math.abs(torchTest[i] - jsTestProbabilities[i]));
  }

  check(
    `JS probabilities reproduce PyTorch within ${FLOAT_TOLERANCE} (max delta ${maxDelta.toExponential(3)})`,
    maxDelta <= FLOAT_TOLERANCE,
    'a larger gap means the JS forward pass is not the function that was fitted',
  );

  const torchTestMetrics = weights.torchCrossCheck.metrics.test;
  check(
    `held-out accuracy matches PyTorch (JS ${metrics.test.accuracy} vs torch ${torchTestMetrics.accuracy})`,
    Math.abs(metrics.test.accuracy - torchTestMetrics.accuracy) < 0.02,
  );
  check(
    `held-out ROC-AUC matches PyTorch (JS ${metrics.test.rocAuc} vs torch ${torchTestMetrics.rocAuc})`,
    Math.abs(metrics.test.rocAuc - torchTestMetrics.rocAuc) < 0.02,
  );

  // --- Feature importances from the shipped attribution code -----------------
  const totals = Object.fromEntries(weights.featureOrder.map((f) => [f, 0]));
  let worstCompleteness = 0;
  let maxRegions = 0;
  let totalRegions = 0;
  for (const vector of split.train.X) {
    const { attributions, completenessGap, regionsVisited } = attributionsFor(vector, {
      maxDepth: IG_MAX_DEPTH,
    });
    worstCompleteness = Math.max(worstCompleteness, Math.abs(completenessGap));
    maxRegions = Math.max(maxRegions, regionsVisited);
    totalRegions += regionsVisited;
    for (const { feature, contribution } of attributions) {
      totals[feature] += Math.abs(contribution);
    }
  }
  const importanceSum = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  const importances = Object.fromEntries(
    Object.entries(totals).map(([name, value]) => [name, Number((value / importanceSum).toFixed(6))]),
  );

  check(
    `integrated gradients satisfy completeness (worst gap ${worstCompleteness.toExponential(3)})`,
    worstCompleteness < IG_COMPLETENESS_TOLERANCE,
    'attributions must sum to logit(patient) - logit(baseline)',
  );
  check(
    'every feature has a non-negative importance',
    Object.values(importances).every((v) => v >= 0),
  );

  if (failures > 0) {
    fs.rmSync(STAGING_PATH, { force: true });
    console.error(`\n${failures} check(s) failed. Nothing was written to shared/risk/.`);
    process.exit(1);
  }

  // --- Pass 2: the real artefact --------------------------------------------
  const crossCheck = {
    reference: `${weights.framework} ${weights.frameworkVersion}`,
    maxProbabilityDelta: Number(maxDelta.toExponential(3)),
    floatTolerance: FLOAT_TOLERANCE,
    worstCompletenessGap: Number(worstCompleteness.toExponential(3)),
    attributionRegionsPerPath: {
      max: maxRegions,
      mean: Number((totalRegions / split.train.X.length).toFixed(2)),
    },
    referenceMetrics: weights.torchCrossCheck.metrics,
    note:
      'metrics in this artefact were computed by its own JavaScript forward pass over ' +
      'the held-out split; referenceMetrics are PyTorch float32 for comparison',
  };

  const artefact = renderArtefact({ weights, split, tree, metrics, bands, importances, crossCheck });

  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  fs.mkdirSync(SHARED_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const exportPath = path.join(EXPORT_DIR, 'neural_model.js');
  const sharedPath = path.join(SHARED_DIR, 'neural_model.js');
  fs.writeFileSync(exportPath, artefact, 'utf8');
  fs.writeFileSync(sharedPath, artefact, 'utf8');
  fs.rmSync(STAGING_PATH, { force: true });

  const metadata = {
    generatedAt: weights.generatedAt,
    generatedBy: `${weights.generatedBy} + ml/export_neural.mjs`,
    role: 'second-opinion',
    authoritativeForRiskBand: false,
    framework: weights.framework,
    frameworkVersion: weights.frameworkVersion,
    algorithm: weights.algorithm,
    hyperparameters: weights.hyperparameters,
    epochSelection: weights.epochSelection,
    parameterCount: weights.parameterCount,
    featureOrder: weights.featureOrder,
    standardisation: weights.standardisation,
    attributionBaseline: weights.attributionBaseline,
    attributionMethod:
      'integrated gradients, integrated exactly by subdividing the path at ReLU kinks',
    attributionMaxDepth: IG_MAX_DEPTH,
    attributionInitialSegments: IG_INITIAL_SEGMENTS,
    riskBands: weights.riskBands,
    featureImportances: importances,
    metrics,
    heldOutBandSummary: bands,
    crossCheck,
    comparisonWithShippedTree: {
      tree: { metrics: tree.metrics.test, heldOutBandSummary: tree.heldOutBandSummary },
      neural: { metrics: metrics.test, heldOutBandSummary: bands },
    },
    dataset: {
      name: tree.dataset.name,
      records: tree.dataset.records,
      trainRecords: split.train.y.length,
      testRecords: split.test.y.length,
      knownLimitation: tree.dataset.knownLimitation,
    },
  };
  const metadataPath = path.join(EXPORT_DIR, 'neural_metadata.json');
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');

  const reportPath = path.join(REPORT_DIR, 'neural_report.md');
  fs.writeFileSync(reportPath, renderReport({ metadata, tree, split, importances }), 'utf8');

  // --- Report ---------------------------------------------------------------
  const bytes = Buffer.byteLength(artefact, 'utf8');
  console.log('\nHeld-out metrics, measured by the exported JavaScript:');
  console.log(`  accuracy    ${(metrics.test.accuracy * 100).toFixed(1)}%   (tree ${(tree.metrics.test.accuracy * 100).toFixed(1)}%)`);
  console.log(`  recall      ${(metrics.test.recall * 100).toFixed(1)}%   (tree ${(tree.metrics.test.recall * 100).toFixed(1)}%)`);
  console.log(`  precision   ${(metrics.test.precision * 100).toFixed(1)}%   (tree ${(tree.metrics.test.precision * 100).toFixed(1)}%)`);
  console.log(`  ROC-AUC     ${metrics.test.rocAuc}    (tree ${tree.metrics.test.rocAuc})`);

  console.log('\nBand spread on held-out data (neural vs shipped tree):');
  for (const name of ['LOW', 'MODERATE', 'HIGH']) {
    const n = bands[name];
    const t = tree.heldOutBandSummary[name];
    console.log(
      `  ${name.padEnd(9)} neural ${String(n.patients).padStart(3)} (${(n.share * 100).toFixed(1)}%)` +
        `   tree ${String(t.patients).padStart(3)} (${((t.patients / split.test.y.length) * 100).toFixed(1)}%)`,
    );
  }

  console.log('\nFeature importance (mean |integrated gradient|, training split):');
  Object.entries(importances)
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, value]) => {
      const bar = '#'.repeat(Math.max(0, Math.round(value * 60)));
      console.log(`  ${name.padEnd(14)} ${(value * 100).toFixed(1).padStart(5)}%  ${bar}`);
    });

  console.log(`\nArtefact size: ${(bytes / 1024).toFixed(1)} KB unminified`);
  console.log('\nWrote:');
  console.log(`  ${path.relative(REPO_ROOT, exportPath)}`);
  console.log(`  ${path.relative(REPO_ROOT, sharedPath)}`);
  console.log(`  ${path.relative(REPO_ROOT, metadataPath)}`);
  console.log(`  ${path.relative(REPO_ROOT, reportPath)}`);
}

main().catch((error) => {
  fs.rmSync(STAGING_PATH, { force: true });
  console.error(error);
  process.exit(1);
});
