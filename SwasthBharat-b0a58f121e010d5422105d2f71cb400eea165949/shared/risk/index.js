/**
 * Public surface of the shared risk engine.
 *
 * Imported by the React PWA (`@shared/risk`) and the Express API
 * (`../../shared/risk/index.js`) so both sides score patients identically.
 */

export {
  RISK_ENGINE_VERSION,
  RISK_BANDS,
  GLUCOSE_MEASUREMENT_TYPES,
  DEFAULT_GLUCOSE_MEASUREMENT_TYPE,
  BMI_CATEGORIES,
  DIASTOLIC_BP_RANGES,
  SCREENING_AGE,
  INPUT_RANGES,
  FEATURE_ORDER,
  MODEL_META,
  NEURAL_META,
  IMPUTED_WHEN_MISSING,
  calculateBmi,
  bmiCategory,
  glucoseCategory,
  diastolicBpCategory,
  validateAssessmentInput,
  buildFeatureVector,
  assessDiabetesRisk,
} from './riskEngine.js';

export { DECISION_TREE, predictWithTree, bandForProbability } from './decision_tree_rules.js';

/**
 * The neural second opinion. The decision tree above remains authoritative for the
 * risk band; these are exported for the model-card page and for anyone who wants to
 * score or attribute directly. See ml/README.md for why it was not promoted.
 */
export {
  NEURAL_FEATURE_ORDER,
  NEURAL_WEIGHTS,
  predictWithNetwork,
  attributionsFor,
  neuralBandForProbability,
} from './neural_model.js';
