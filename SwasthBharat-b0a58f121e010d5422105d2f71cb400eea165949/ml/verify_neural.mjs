/**
 * Re-verifies the COMMITTED neural artefact. Read-only.
 *
 *   node ml/verify_neural.mjs        (or: npm run ml:verify)
 *
 * Unlike ml/export_neural.mjs this regenerates nothing, needs no Python, and cannot
 * touch shared/risk/. It answers one question: does the neural model currently sitting
 * in shared/risk/ still do what its own metadata claims?
 *
 * It rebuilds the train/test split straight from the CSV rather than reading
 * ml/export/dataset_split.json, so a corrupted or stale split file cannot make a
 * broken model look fine.
 *
 * Safe to run in front of an audience, and worth running before a demo: it is the
 * cheapest way to catch a hand-edit of an auto-generated file, or a shared/risk copy
 * that drifted from ml/export.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ML_ROOT, REPO_ROOT, prepareDataset, bandSummary } from './lib/dataset.mjs';
import { classificationMetrics, rocAuc } from './lib/cart.mjs';

const SHARED_ARTEFACT = path.join(REPO_ROOT, 'shared', 'risk', 'neural_model.js');
const EXPORT_ARTEFACT = path.join(ML_ROOT, 'export', 'neural_model.js');
const TREE_METADATA = path.join(ML_ROOT, 'export', 'model_metadata.json');

/** The scripted demo screening. Kept identical to backend/scripts/check-demo-flow.mjs. */
const DEMO_CASE = {
  label: 'demo case (glucose 165, BMI 31, family history, age 46)',
  // FEATURE_ORDER: glucose, diastolicBp, bmi, age, pregnancies, familyHistory, skinThickness, insulin
  vector: [165, 88, 31, 46, 3, 1, 30, 125],
};

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

function near(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

async function main() {
  console.log('Verifying the committed neural artefact (read-only)\n');

  if (!fs.existsSync(SHARED_ARTEFACT)) {
    console.error(`Missing ${path.relative(REPO_ROOT, SHARED_ARTEFACT)}`);
    console.error('Regenerate: node ml/prepare_dataset.mjs && python ml/train_neural.py && node ml/export_neural.mjs');
    process.exit(1);
  }

  const artefact = await import(pathToFileURL(SHARED_ARTEFACT).href);
  const { NEURAL_META, NEURAL_FEATURE_ORDER, NEURAL_WEIGHTS, predictWithNetwork, attributionsFor, neuralBandForProbability } =
    artefact;

  console.log(`Artefact:   ${path.relative(REPO_ROOT, SHARED_ARTEFACT)}`);
  console.log(`Generated:  ${NEURAL_META.generatedAt}`);
  console.log(`Trained by: ${NEURAL_META.generatedBy}`);
  console.log(`Role:       ${NEURAL_META.role} (authoritative for band: ${NEURAL_META.authoritativeForRiskBand})\n`);

  // --- The two copies must not have drifted ----------------------------------
  console.log('Artefact integrity:');
  check(
    'shared/risk copy is byte-identical to ml/export copy',
    fs.existsSync(EXPORT_ARTEFACT) &&
      fs.readFileSync(SHARED_ARTEFACT, 'utf8') === fs.readFileSync(EXPORT_ARTEFACT, 'utf8'),
  );

  const parameterCount =
    NEURAL_WEIGHTS.l1.weight.flat().length +
    NEURAL_WEIGHTS.l1.bias.length +
    NEURAL_WEIGHTS.l2.weight.flat().length +
    NEURAL_WEIGHTS.l2.bias.length +
    NEURAL_WEIGHTS.out.weight.flat().length +
    NEURAL_WEIGHTS.out.bias.length;
  check(
    `parameter count matches metadata (${parameterCount})`,
    parameterCount === NEURAL_META.parameterCount,
    `counted ${parameterCount}, metadata says ${NEURAL_META.parameterCount}`,
  );
  check(
    'every weight is a finite number',
    [
      ...NEURAL_WEIGHTS.l1.weight.flat(),
      ...NEURAL_WEIGHTS.l1.bias,
      ...NEURAL_WEIGHTS.l2.weight.flat(),
      ...NEURAL_WEIGHTS.l2.bias,
      ...NEURAL_WEIGHTS.out.weight.flat(),
      ...NEURAL_WEIGHTS.out.bias,
    ].every((v) => Number.isFinite(v)),
  );

  // --- Feature order must match the tree, or the vectors mean different things -
  const tree = JSON.parse(fs.readFileSync(TREE_METADATA, 'utf8'));
  check(
    'feature order matches the shipped decision tree',
    JSON.stringify(NEURAL_FEATURE_ORDER) === JSON.stringify(tree.featureOrder),
    `${JSON.stringify(NEURAL_FEATURE_ORDER)} vs ${JSON.stringify(tree.featureOrder)}`,
  );
  check(
    'risk band cut-offs match the shipped decision tree',
    JSON.stringify(NEURAL_META.riskBands) === JSON.stringify(tree.riskBands),
  );

  // --- Re-measure from the raw CSV -------------------------------------------
  console.log('\nRe-measuring against a split rebuilt from the CSV:');
  const prepared = prepareDataset();

  check(
    'held-out row count matches metadata',
    prepared.test.y.length === NEURAL_META.dataset.testRecords,
    `${prepared.test.y.length} vs ${NEURAL_META.dataset.testRecords}`,
  );

  const probabilities = prepared.test.X.map((v) => predictWithNetwork(v).probability);
  const metrics = {
    ...classificationMetrics(prepared.test.y, probabilities, 0.5),
    rocAuc: rocAuc(prepared.test.y, probabilities),
  };
  const bands = bandSummary(prepared.test.y, probabilities, NEURAL_META.riskBands);

  for (const key of ['accuracy', 'precision', 'recall', 'specificity', 'f1', 'rocAuc']) {
    check(
      `held-out ${key} reproduces metadata (${metrics[key]})`,
      near(metrics[key], NEURAL_META.metrics.test[key], 1e-4),
      `recomputed ${metrics[key]}, metadata says ${NEURAL_META.metrics.test[key]}`,
    );
  }

  for (const band of ['LOW', 'MODERATE', 'HIGH']) {
    check(
      `${band} band population reproduces metadata (${bands[band].patients})`,
      bands[band].patients === NEURAL_META.heldOutBandSummary[band].patients,
      `recomputed ${bands[band].patients}, metadata says ${NEURAL_META.heldOutBandSummary[band].patients}`,
    );
  }

  // --- Properties that must hold for the model to be usable at all -----------
  console.log('\nModel properties:');
  check(
    'all probabilities are within [0, 1]',
    probabilities.every((p) => p >= 0 && p <= 1),
  );
  check(
    'every risk band is populated on held-out data',
    ['LOW', 'MODERATE', 'HIGH'].every((b) => bands[b].patients > 0),
    'a band nobody lands in is not a band',
  );
  check(
    'diabetic rate increases monotonically LOW -> MODERATE -> HIGH',
    bands.LOW.actualDiabeticRate <= bands.MODERATE.actualDiabeticRate &&
      bands.MODERATE.actualDiabeticRate <= bands.HIGH.actualDiabeticRate,
    `${bands.LOW.actualDiabeticRate} / ${bands.MODERATE.actualDiabeticRate} / ${bands.HIGH.actualDiabeticRate}`,
  );

  let worstGap = 0;
  for (const vector of prepared.test.X) {
    worstGap = Math.max(worstGap, Math.abs(attributionsFor(vector).completenessGap));
  }
  check(
    `attributions sum to the logit shift on every held-out patient (worst ${worstGap.toExponential(3)})`,
    worstGap < 1e-5,
  );

  check(
    'predictWithNetwork rejects a wrong-length vector',
    (() => {
      try {
        predictWithNetwork([1, 2, 3]);
        return false;
      } catch {
        return true;
      }
    })(),
  );

  // --- The scripted demo case ------------------------------------------------
  console.log(`\n${DEMO_CASE.label}:`);
  const demo = predictWithNetwork(DEMO_CASE.vector);
  const demoBand = neuralBandForProbability(demo.probability);
  const demoAttribution = attributionsFor(DEMO_CASE.vector);

  console.log(
    `  neural second opinion: ${demoBand} ${Math.round(demo.probability * 100)}%` +
      `   (tree ships HIGH 95%)`,
  );
  console.log('  attribution, largest first:');
  demoAttribution.attributions.forEach(({ feature, contribution, share, direction }) => {
    const arrow = direction === 'increases' ? '+' : direction === 'decreases' ? '-' : ' ';
    console.log(
      `    ${arrow} ${feature.padEnd(14)} ${contribution.toFixed(4).padStart(9)}` +
        `  (${(share * 100).toFixed(1)}% of total movement)`,
    );
  });

  check(
    'demo case is HIGH for the neural model too',
    demoBand === 'HIGH',
    `got ${demoBand} ${Math.round(demo.probability * 100)}%`,
  );
  check(
    'glucose is among the two strongest contributors for the demo case',
    demoAttribution.attributions.slice(0, 2).some((a) => a.feature === 'glucose'),
    demoAttribution.attributions.map((a) => a.feature).join(' > '),
  );
  check(
    'family history pushes the demo case upward',
    demoAttribution.attributions.find((a) => a.feature === 'familyHistory')?.direction === 'increases',
  );

  // --- Summary ---------------------------------------------------------------
  console.log('');
  if (failures > 0) {
    console.error(`${failures} check(s) FAILED.`);
    process.exit(1);
  }
  console.log('All checks passed. The committed neural artefact matches its own metadata.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
