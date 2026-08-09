/**
 * Diabetes early-risk engine.
 *
 * Wraps the trained decision tree (`decision_tree_rules.js`) with everything needed to
 * turn a health worker's form into something a person can act on:
 *
 *   form input -> validation -> feature vector -> tree -> risk band + plain-language reasons
 *
 * This module is plain ES module JavaScript on purpose. It is imported by BOTH:
 *   - the React PWA, so a risk result can be produced with no network at all
 *   - the Express API, so a synced record is re-scored server-side by identical logic
 *
 * If these two ever disagreed, a patient could see one risk in the field and a doctor
 * a different one on the dashboard. Sharing the module makes that impossible.
 *
 * IMPORTANT: the tree's numeric splits come from the Pima cohort (see ml/README.md).
 * The plain-language explanations deliberately do NOT quote the tree's thresholds as
 * clinical advice. They use Indian clinical reference ranges instead. The tree decides
 * the band; the reference ranges describe *why* in language that is locally correct.
 */

import {
  FEATURE_ORDER,
  MODEL_META,
  IMPUTED_WHEN_MISSING,
  predictWithTree,
  bandForProbability,
} from './decision_tree_rules.js';
import {
  NEURAL_META,
  predictWithNetwork,
  attributionsFor,
  neuralBandForProbability,
} from './neural_model.js';

export { FEATURE_ORDER, MODEL_META, IMPUTED_WHEN_MISSING, NEURAL_META };

/**
 * Bumped when the input contract or explanation logic changes.
 *
 * 1.1.0 added the neural second opinion and per-feature attributions. Both are
 * ADDITIVE: `riskBand`, `probability`, `riskPercent`, `reasons`, `recommendations`,
 * `decisionPath` and `model` are produced by exactly the same code as in 1.0.0, so a
 * record scored by an older bundle stays valid and comparable.
 */
export const RISK_ENGINE_VERSION = '1.1.0';

export const RISK_BANDS = ['LOW', 'MODERATE', 'HIGH'];

/**
 * How the blood sugar sample was taken. The Pima `Glucose` column is a 2-hour oral
 * glucose tolerance test value, but a health worker on a home visit is far more likely
 * to have a fasting or random capillary reading. We cannot change what the model was
 * trained on, so we at least interpret the number correctly when explaining it.
 *
 * Thresholds follow the WHO / ICMR diagnostic ranges for each sample type (mg/dL).
 */
export const GLUCOSE_MEASUREMENT_TYPES = {
  fasting: { prediabetes: 100, diabetes: 126 },
  ogtt2h: { prediabetes: 140, diabetes: 200 },
  random: { prediabetes: 140, diabetes: 200 },
};

export const DEFAULT_GLUCOSE_MEASUREMENT_TYPE = 'fasting';

/**
 * WHO Asian-Indian BMI cut-offs, which are lower than the international 25/30 because
 * South Asians carry more visceral fat and develop insulin resistance at a lower BMI.
 * Using the international cut-offs here would under-flag Indian patients.
 */
export const BMI_CATEGORIES = {
  underweight: { max: 18.5 },
  normal: { min: 18.5, max: 23 },
  overweight: { min: 23, max: 25 },
  obese: { min: 25 },
};

/** Diastolic blood pressure reference ranges (mm Hg). */
export const DIASTOLIC_BP_RANGES = { elevated: 80, high: 90 };

/** Age at which routine diabetes screening is advised in India. */
export const SCREENING_AGE = { advisory: 35, elevated: 45 };

/**
 * Accepted input ranges. Shared so the form, the API and the offline sync path all
 * reject the same nonsense — a typo'd "1650" glucose must not reach the model.
 */
export const INPUT_RANGES = {
  age: { min: 12, max: 120, unit: 'years' },
  glucoseMgDl: { min: 30, max: 600, unit: 'mg/dL' },
  diastolicBpMmHg: { min: 30, max: 150, unit: 'mm Hg' },
  heightCm: { min: 90, max: 250, unit: 'cm' },
  weightKg: { min: 20, max: 300, unit: 'kg' },
  pregnancies: { min: 0, max: 20, unit: 'count' },
  skinThicknessMm: { min: 5, max: 99, unit: 'mm' },
  insulinMuUml: { min: 10, max: 900, unit: 'mu U/ml' },
};

/**
 * Severity ordering used to sort the reason list, most important first.
 * `note` is data-provenance housekeeping (e.g. "a default value was substituted") and
 * always sorts last so it never crowds out an actual clinical finding.
 */
const SEVERITY_RANK = { high: 0, moderate: 1, info: 2, good: 3, note: 4 };

/* ------------------------------------------------------------------------- */
/* Derived values                                                            */
/* ------------------------------------------------------------------------- */

/**
 * BMI from height and weight. The worker enters height and weight because asking a
 * village health worker to compute kg/m^2 on paper is how you get bad data.
 *
 * @param {number} heightCm
 * @param {number} weightKg
 * @returns {number|null} BMI rounded to one decimal, or null if inputs are unusable
 */
export function calculateBmi(heightCm, weightKg) {
  const h = Number(heightCm);
  const w = Number(weightKg);
  if (!Number.isFinite(h) || !Number.isFinite(w) || h <= 0 || w <= 0) return null;
  const metres = h / 100;
  return Math.round((w / (metres * metres)) * 10) / 10;
}

/** @returns {'underweight'|'normal'|'overweight'|'obese'} */
export function bmiCategory(bmi) {
  if (bmi < BMI_CATEGORIES.underweight.max) return 'underweight';
  if (bmi < BMI_CATEGORIES.normal.max) return 'normal';
  if (bmi < BMI_CATEGORIES.overweight.max) return 'overweight';
  return 'obese';
}

/** @returns {'normal'|'prediabetes'|'diabetes'} */
export function glucoseCategory(glucoseMgDl, measurementType = DEFAULT_GLUCOSE_MEASUREMENT_TYPE) {
  const thresholds =
    GLUCOSE_MEASUREMENT_TYPES[measurementType] ||
    GLUCOSE_MEASUREMENT_TYPES[DEFAULT_GLUCOSE_MEASUREMENT_TYPE];
  if (glucoseMgDl >= thresholds.diabetes) return 'diabetes';
  if (glucoseMgDl >= thresholds.prediabetes) return 'prediabetes';
  return 'normal';
}

/** @returns {'normal'|'elevated'|'high'} */
export function diastolicBpCategory(diastolicBpMmHg) {
  if (diastolicBpMmHg >= DIASTOLIC_BP_RANGES.high) return 'high';
  if (diastolicBpMmHg >= DIASTOLIC_BP_RANGES.elevated) return 'elevated';
  return 'normal';
}

/* ------------------------------------------------------------------------- */
/* Validation                                                                */
/* ------------------------------------------------------------------------- */

function isBlank(value) {
  return value === undefined || value === null || value === '';
}

function numberOrNull(value) {
  if (isBlank(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * Validates a raw assessment form payload.
 *
 * Returns error objects rather than throwing or returning strings, because the caller
 * needs to attach each error to a specific form field and translate it.
 *
 * @param {object} input
 * @returns {{valid: boolean, errors: Array<{field: string, code: string, i18nKey: string, params?: object}>}}
 */
export function validateAssessmentInput(input = {}) {
  const errors = [];

  const requireInRange = (field, { required = true } = {}) => {
    const range = INPUT_RANGES[field];
    const value = numberOrNull(input[field]);

    if (value === null) {
      if (required) {
        errors.push({ field, code: 'REQUIRED', i18nKey: 'validation.required' });
      }
      return null;
    }
    if (Number.isNaN(value)) {
      errors.push({ field, code: 'NOT_A_NUMBER', i18nKey: 'validation.notANumber' });
      return null;
    }
    if (value < range.min || value > range.max) {
      errors.push({
        field,
        code: 'OUT_OF_RANGE',
        i18nKey: 'validation.outOfRange',
        params: { min: range.min, max: range.max, unit: range.unit },
      });
      return null;
    }
    return value;
  };

  const sex = input.sex;
  if (sex !== 'female' && sex !== 'male') {
    errors.push({ field: 'sex', code: 'REQUIRED', i18nKey: 'validation.selectOption' });
  }

  requireInRange('age');
  requireInRange('glucoseMgDl');
  requireInRange('diastolicBpMmHg');
  requireInRange('heightCm');
  requireInRange('weightKg');
  requireInRange('skinThicknessMm', { required: false });
  requireInRange('insulinMuUml', { required: false });

  // Pregnancies is only meaningful for female patients; the form hides it otherwise.
  if (sex === 'female') {
    requireInRange('pregnancies');
  }

  if (
    !isBlank(input.glucoseMeasurementType) &&
    !GLUCOSE_MEASUREMENT_TYPES[input.glucoseMeasurementType]
  ) {
    errors.push({
      field: 'glucoseMeasurementType',
      code: 'INVALID_OPTION',
      i18nKey: 'validation.selectOption',
    });
  }

  if (typeof input.familyHistoryDiabetes !== 'boolean') {
    errors.push({
      field: 'familyHistoryDiabetes',
      code: 'REQUIRED',
      i18nKey: 'validation.selectOption',
    });
  }

  return { valid: errors.length === 0, errors };
}

/* ------------------------------------------------------------------------- */
/* Feature vector                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Maps validated form input onto the model's feature vector.
 *
 * @param {object} input
 * @returns {{vector: number[], features: Record<string, number>, imputedFields: string[], bmi: number}}
 */
export function buildFeatureVector(input) {
  const bmi = Number.isFinite(Number(input.bmi))
    ? Math.round(Number(input.bmi) * 10) / 10
    : calculateBmi(input.heightCm, input.weightKg);

  const imputedFields = [];

  const skinThickness = numberOrNull(input.skinThicknessMm);
  const insulin = numberOrNull(input.insulinMuUml);

  let skinThicknessValue = skinThickness;
  if (skinThicknessValue === null || Number.isNaN(skinThicknessValue)) {
    skinThicknessValue = IMPUTED_WHEN_MISSING.skinThickness;
    imputedFields.push('skinThicknessMm');
  }

  let insulinValue = insulin;
  if (insulinValue === null || Number.isNaN(insulinValue)) {
    insulinValue = IMPUTED_WHEN_MISSING.insulin;
    imputedFields.push('insulinMuUml');
  }

  // Male patients have no pregnancy count; 0 is the correct value, not a missing one.
  const pregnancies = input.sex === 'female' ? Number(input.pregnancies) || 0 : 0;

  const features = {
    glucose: Number(input.glucoseMgDl),
    diastolicBp: Number(input.diastolicBpMmHg),
    bmi,
    age: Number(input.age),
    familyHistory: input.familyHistoryDiabetes ? 1 : 0,
    pregnancies,
    skinThickness: skinThicknessValue,
    insulin: insulinValue,
  };

  // Build the array strictly from FEATURE_ORDER so a retrain that reorders features
  // cannot silently shift values into the wrong slots.
  const vector = FEATURE_ORDER.map((name) => {
    const value = features[name];
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot build feature vector: "${name}" resolved to ${value}`);
    }
    return value;
  });

  return { vector, features, imputedFields, bmi };
}

/* ------------------------------------------------------------------------- */
/* Explanations                                                              */
/* ------------------------------------------------------------------------- */

/**
 * Builds the ordered, plain-language reason list.
 *
 * Design note: these reasons are derived from clinical reference ranges, NOT from the
 * tree's split thresholds. A health worker needs "blood sugar 165 mg/dL is in the
 * diabetes range", not "glucose > 157.5 was the third node". The tree path is returned
 * separately for the doctor-facing view.
 *
 * `fallbackEn` is a non-UI convenience for logs, API consumers and SMS drafts. The apps
 * render `i18nKey` + `params` through their own translation files.
 */
function buildReasons({ features, input, bmiLabel, glucoseLabel, bpLabel, imputedFields }) {
  const reasons = [];
  const measurementType = input.glucoseMeasurementType || DEFAULT_GLUCOSE_MEASUREMENT_TYPE;

  if (glucoseLabel === 'diabetes') {
    reasons.push({
      code: 'GLUCOSE_DIABETES_RANGE',
      severity: 'high',
      i18nKey: 'reason.glucose.diabetesRange',
      params: { value: features.glucose, measurementType },
      fallbackEn: `Blood sugar ${features.glucose} mg/dL is in the diabetes range for a ${measurementType} sample`,
    });
  } else if (glucoseLabel === 'prediabetes') {
    reasons.push({
      code: 'GLUCOSE_PREDIABETES_RANGE',
      severity: 'moderate',
      i18nKey: 'reason.glucose.prediabetesRange',
      params: { value: features.glucose, measurementType },
      fallbackEn: `Blood sugar ${features.glucose} mg/dL is above normal (pre-diabetes range) for a ${measurementType} sample`,
    });
  } else {
    reasons.push({
      code: 'GLUCOSE_NORMAL',
      severity: 'good',
      i18nKey: 'reason.glucose.normal',
      params: { value: features.glucose, measurementType },
      fallbackEn: `Blood sugar ${features.glucose} mg/dL is within the normal range`,
    });
  }

  if (bmiLabel === 'obese') {
    reasons.push({
      code: 'BMI_OBESE',
      severity: 'high',
      i18nKey: 'reason.bmi.obese',
      params: { value: features.bmi },
      fallbackEn: `BMI ${features.bmi} is in the obese range (Indian cut-off 25 and above)`,
    });
  } else if (bmiLabel === 'overweight') {
    reasons.push({
      code: 'BMI_OVERWEIGHT',
      severity: 'moderate',
      i18nKey: 'reason.bmi.overweight',
      params: { value: features.bmi },
      fallbackEn: `BMI ${features.bmi} is in the overweight range (Indian cut-off 23 and above)`,
    });
  } else if (bmiLabel === 'underweight') {
    reasons.push({
      code: 'BMI_UNDERWEIGHT',
      severity: 'info',
      i18nKey: 'reason.bmi.underweight',
      params: { value: features.bmi },
      fallbackEn: `BMI ${features.bmi} is below the healthy range`,
    });
  } else {
    reasons.push({
      code: 'BMI_NORMAL',
      severity: 'good',
      i18nKey: 'reason.bmi.normal',
      params: { value: features.bmi },
      fallbackEn: `BMI ${features.bmi} is in the healthy range`,
    });
  }

  if (features.familyHistory === 1) {
    reasons.push({
      code: 'FAMILY_HISTORY_PRESENT',
      severity: 'moderate',
      i18nKey: 'reason.familyHistory.present',
      fallbackEn: 'A parent or sibling has diabetes',
    });
  }

  if (bpLabel === 'high') {
    reasons.push({
      code: 'BP_HIGH',
      severity: 'high',
      i18nKey: 'reason.bp.high',
      params: { value: features.diastolicBp },
      fallbackEn: `Diastolic blood pressure ${features.diastolicBp} mm Hg is high`,
    });
  } else if (bpLabel === 'elevated') {
    reasons.push({
      code: 'BP_ELEVATED',
      severity: 'moderate',
      i18nKey: 'reason.bp.elevated',
      params: { value: features.diastolicBp },
      fallbackEn: `Diastolic blood pressure ${features.diastolicBp} mm Hg is slightly raised`,
    });
  }

  if (features.age >= SCREENING_AGE.elevated) {
    reasons.push({
      code: 'AGE_ELEVATED',
      severity: 'moderate',
      i18nKey: 'reason.age.elevated',
      params: { value: features.age, threshold: SCREENING_AGE.elevated },
      fallbackEn: `Age ${features.age} — diabetes risk rises after ${SCREENING_AGE.elevated}`,
    });
  } else if (features.age >= SCREENING_AGE.advisory) {
    reasons.push({
      code: 'AGE_ADVISORY',
      severity: 'info',
      i18nKey: 'reason.age.advisory',
      params: { value: features.age, threshold: SCREENING_AGE.advisory },
      fallbackEn: `Age ${features.age} — routine screening is advised from ${SCREENING_AGE.advisory}`,
    });
  }

  if (input.sex === 'female' && features.pregnancies >= 4) {
    reasons.push({
      code: 'HIGH_PARITY',
      severity: 'info',
      i18nKey: 'reason.pregnancies.high',
      params: { value: features.pregnancies },
      fallbackEn: `${features.pregnancies} pregnancies — higher parity is associated with increased diabetes risk`,
    });
  }

  if (imputedFields.length > 0) {
    reasons.push({
      code: 'MODEL_DEFAULTS_USED',
      severity: 'note',
      i18nKey: 'reason.defaultsUsed',
      params: { fields: imputedFields },
      fallbackEn: `Typical values were used for ${imputedFields.join(', ')} because they were not measured`,
    });
  }

  return reasons.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

/** Band-specific next steps. Kept as i18n keys so they read naturally in each language. */
function buildRecommendations(band, glucoseLabel) {
  const recommendations = [];

  if (band === 'HIGH') {
    recommendations.push(
      { code: 'REFER_PHC_URGENT', i18nKey: 'advice.referPhcUrgent' },
      { code: 'CONFIRM_WITH_LAB', i18nKey: 'advice.confirmWithLab' },
      { code: 'BOOK_TELECONSULT', i18nKey: 'advice.bookTeleconsult' },
    );
  } else if (band === 'MODERATE') {
    recommendations.push(
      { code: 'RECHECK_3_MONTHS', i18nKey: 'advice.recheck3Months' },
      { code: 'LIFESTYLE_COUNSELLING', i18nKey: 'advice.lifestyleCounselling' },
    );
  } else {
    recommendations.push(
      { code: 'RECHECK_ANNUALLY', i18nKey: 'advice.recheckAnnually' },
      { code: 'MAINTAIN_LIFESTYLE', i18nKey: 'advice.maintainLifestyle' },
    );
  }

  if (glucoseLabel === 'diabetes') {
    recommendations.unshift({ code: 'SAME_WEEK_REVIEW', i18nKey: 'advice.sameWeekReview' });
  }

  return recommendations;
}

/* ------------------------------------------------------------------------- */
/* Neural second opinion                                                     */
/* ------------------------------------------------------------------------- */

/** Ordinal positions so two bands can be compared, not just tested for equality. */
const BAND_ORDER = { LOW: 0, MODERATE: 1, HIGH: 2 };

/**
 * Runs the neural model alongside the tree and reports where they differ.
 *
 * THE TREE DECIDES THE BAND. This function never influences `riskBand`. It exists
 * for two reasons:
 *
 *   1. Attributions. The tree can only explain itself with the <= 4 comparisons on
 *      the path it happened to take, and says nothing about the features it did not
 *      split on. The network attributes the score across all eight inputs, signed.
 *   2. Disagreement as a signal. When a depth-4 tree and a neural net put the same
 *      patient in different bands, that patient is near a boundary — which is
 *      exactly who a PHC doctor should look at first. Hiding that would throw away
 *      the most useful thing about having two models.
 *
 * FAILURE IS NON-FATAL, BY DESIGN. Everything the app needs to act on a patient
 * comes from the tree and the clinical reference ranges. If the neural artefact is
 * missing, corrupt, or throws, the assessment must still succeed with a correct band
 * and correct reasons — so this is wrapped and degrades to `null` rather than
 * failing the screening of a patient standing in front of a health worker.
 *
 * @param {number[]} vector feature vector ordered as FEATURE_ORDER
 * @param {Record<string, number>} features named feature values, for display
 * @param {'LOW'|'MODERATE'|'HIGH'} primaryBand the tree's band
 * @param {string[]} imputedFields fields filled from a median rather than measured
 */
function buildSecondOpinion(vector, features, primaryBand, imputedFields) {
  try {
    const { probability, logit } = predictWithNetwork(vector);
    const band = neuralBandForProbability(probability);
    const { attributions, baselineLogit, completenessGap } = attributionsFor(vector);

    const baseline = NEURAL_META.attributionBaseline;

    return {
      secondOpinion: {
        source: 'neural',
        algorithm: NEURAL_META.algorithm,
        framework: NEURAL_META.framework,
        generatedAt: NEURAL_META.generatedAt,
        probability,
        riskPercent: Math.round(probability * 100),
        riskBand: band,
        /** True when both models put the patient in the same band. */
        agreesWithPrimary: band === primaryBand,
        /**
         * Signed band distance, neural minus tree, in band steps. +1 means the
         * network is one band more alarmed than the tree, -1 one band less.
         */
        bandDelta: BAND_ORDER[band] - BAND_ORDER[primaryBand],
        heldOutAccuracy: NEURAL_META.metrics.test.accuracy,
        heldOutRecall: NEURAL_META.metrics.test.recall,
        heldOutRocAuc: NEURAL_META.metrics.test.rocAuc,
        isPrototype: true,
      },
      /**
       * Signed per-feature contributions to the neural score.
       *
       * Each entry carries BOTH the patient's value and the baseline it is being
       * compared against, because without the baseline the numbers read as
       * self-contradictory. Worked example from the demo case: BMI 31 gets a small
       * NEGATIVE contribution, because the comparison patient is the Pima training
       * median of 32.3 — while the reason list simultaneously and correctly says
       * "BMI 31 is in the obese range" against the Indian cut-off of 25. Both
       * statements are true; only showing the baseline makes that legible.
       *
       * `imputed` marks the features that were never measured. Those contribute
       * exactly 0.0, because the value substituted for them IS the baseline — the
       * model is given no information by a default, and the attribution says so
       * rather than inventing an influence for a number nobody collected.
       */
      attributions: attributions.map((entry) => {
        const index = FEATURE_ORDER.indexOf(entry.feature);
        return {
          ...entry,
          value: features[entry.feature],
          baseline: index >= 0 ? baseline[index] : null,
          imputed:
            (entry.feature === 'skinThickness' && imputedFields.includes('skinThicknessMm')) ||
            (entry.feature === 'insulin' && imputedFields.includes('insulinMuUml')),
        };
      }),
      attributionMeta: {
        method: NEURAL_META.attributionMethod,
        /** Comparison patient: the median of the training split, feature by feature. */
        baseline: Object.fromEntries(FEATURE_ORDER.map((name, i) => [name, baseline[i]])),
        logit,
        baselineLogit,
        completenessGap,
      },
    };
  } catch {
    // Degrade silently: the tree's band and the clinical reasons are unaffected.
    return { secondOpinion: null, attributions: [], attributionMeta: null };
  }
}

/* ------------------------------------------------------------------------- */
/* Public entry point                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Scores a patient and explains the score.
 *
 * @param {object} input raw form payload
 * @returns {{
 *   riskBand: 'LOW'|'MODERATE'|'HIGH',
 *   probability: number,
 *   riskPercent: number,
 *   isHighRisk: boolean,
 *   features: Record<string, number>,
 *   derived: {bmi: number, bmiCategory: string, glucoseCategory: string, diastolicBpCategory: string},
 *   imputedFields: string[],
 *   reasons: Array<object>,
 *   recommendations: Array<object>,
 *   decisionPath: Array<{feature: string, operator: string, threshold: number, value: number}>,
 *   secondOpinion: object|null,
 *   attributions: Array<object>,
 *   attributionMeta: object|null,
 *   model: object
 * }}
 * @throws {Error} with `.validationErrors` when the input is not usable
 */
export function assessDiabetesRisk(input = {}) {
  const { valid, errors } = validateAssessmentInput(input);
  if (!valid) {
    const error = new Error('Assessment input failed validation');
    error.code = 'VALIDATION_FAILED';
    error.validationErrors = errors;
    throw error;
  }

  const { vector, features, imputedFields, bmi } = buildFeatureVector(input);
  const { probability, leafId, samples, path } = predictWithTree(vector);
  const riskBand = bandForProbability(probability);

  const measurementType = input.glucoseMeasurementType || DEFAULT_GLUCOSE_MEASUREMENT_TYPE;
  const glucoseLabel = glucoseCategory(features.glucose, measurementType);
  const bmiLabel = bmiCategory(bmi);
  const bpLabel = diastolicBpCategory(features.diastolicBp);

  // Runs after the band is already decided, and cannot change it.
  const { secondOpinion, attributions, attributionMeta } = buildSecondOpinion(
    vector,
    features,
    riskBand,
    imputedFields,
  );

  return {
    riskBand,
    probability,
    riskPercent: Math.round(probability * 100),
    isHighRisk: riskBand === 'HIGH',
    features,
    derived: {
      bmi,
      bmiCategory: bmiLabel,
      glucoseCategory: glucoseLabel,
      glucoseMeasurementType: measurementType,
      diastolicBpCategory: bpLabel,
    },
    imputedFields,
    reasons: buildReasons({ features, input, bmiLabel, glucoseLabel, bpLabel, imputedFields }),
    recommendations: buildRecommendations(riskBand, glucoseLabel),
    decisionPath: path,
    secondOpinion,
    attributions,
    attributionMeta,
    model: {
      engineVersion: RISK_ENGINE_VERSION,
      /** 'tree' is authoritative. Recorded so a stored record states which model decided. */
      primaryModel: 'tree',
      treeGeneratedAt: MODEL_META.generatedAt,
      leafId,
      leafTrainingSamples: samples,
      heldOutAccuracy: MODEL_META.metrics.test.accuracy,
      heldOutRecall: MODEL_META.metrics.test.recall,
      datasetName: MODEL_META.dataset.name,
      datasetLimitation: MODEL_META.dataset.knownLimitation,
      isPrototype: true,
    },
  };
}
