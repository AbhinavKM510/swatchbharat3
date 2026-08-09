/**
 * Type declarations for the shared risk engine.
 *
 * The engine itself is plain JavaScript so it can be imported unchanged by the Node
 * API and bundled into the offline PWA. These declarations give the TypeScript
 * frontend full type safety over it.
 */

export type RiskBand = 'LOW' | 'MODERATE' | 'HIGH';

export type GlucoseMeasurementType = 'fasting' | 'ogtt2h' | 'random';

export type BmiCategory = 'underweight' | 'normal' | 'overweight' | 'obese';

export type GlucoseCategory = 'normal' | 'prediabetes' | 'diabetes';

export type DiastolicBpCategory = 'normal' | 'elevated' | 'high';

export type ReasonSeverity = 'high' | 'moderate' | 'info' | 'good' | 'note';

export type Sex = 'female' | 'male';

/** Raw payload produced by the assessment form. */
export interface AssessmentInput {
  sex: Sex;
  age: number | string;
  glucoseMgDl: number | string;
  glucoseMeasurementType?: GlucoseMeasurementType;
  diastolicBpMmHg: number | string;
  heightCm: number | string;
  weightKg: number | string;
  /** Normally derived from height + weight; accepted directly for re-scoring. */
  bmi?: number | string;
  familyHistoryDiabetes: boolean;
  /** Required for female patients, ignored for male patients. */
  pregnancies?: number | string;
  /** Optional in the field; falls back to the training-split median. */
  skinThicknessMm?: number | string | null;
  /** Optional in the field; falls back to the training-split median. */
  insulinMuUml?: number | string | null;
}

export interface ValidationError {
  field: string;
  code: 'REQUIRED' | 'NOT_A_NUMBER' | 'OUT_OF_RANGE' | 'INVALID_OPTION';
  i18nKey: string;
  params?: Record<string, unknown>;
}

export interface RiskReason {
  code: string;
  severity: ReasonSeverity;
  i18nKey: string;
  params?: Record<string, unknown>;
  /** Non-UI fallback for logs, SMS drafts and untranslated API consumers. */
  fallbackEn: string;
}

export interface RiskRecommendation {
  code: string;
  i18nKey: string;
}

export interface DecisionPathStep {
  feature: string;
  operator: '<=' | '>';
  threshold: number;
  value: number;
}

export interface ModelFeatures {
  glucose: number;
  diastolicBp: number;
  bmi: number;
  age: number;
  familyHistory: 0 | 1;
  pregnancies: number;
  skinThickness: number;
  insulin: number;
}

/** Whether a feature pushed the neural score up, down, or not at all. */
export type AttributionDirection = 'increases' | 'decreases' | 'neutral';

/**
 * One feature's signed contribution to the neural score.
 *
 * Always render `value` next to `baseline`. A contribution is relative to the
 * baseline patient (the training-split median), so BMI 31 can legitimately show a
 * NEGATIVE contribution — the Pima cohort's median BMI is 32.3 — at the same time as
 * the reason list correctly calls BMI 31 obese against the Indian cut-off of 25.
 * Without the baseline on screen those two facts look like a contradiction.
 */
export interface FeatureAttribution {
  feature: string;
  /** Signed contribution in logit units. Sums to logit(patient) - logit(baseline). */
  contribution: number;
  /** Share of the total absolute movement, 0..1. Use this for bar widths. */
  share: number;
  direction: AttributionDirection;
  /** The patient's value for this feature. */
  value: number;
  /** The comparison value: this feature's median in the training split. */
  baseline: number | null;
  /** True when the value was substituted from a median rather than measured. */
  imputed: boolean;
}

/**
 * The neural model's independent read on the same patient.
 *
 * `null` when the neural artefact could not be evaluated. The primary band, reasons
 * and recommendations never depend on it, so callers must treat this as optional
 * rather than assuming it is present.
 */
export interface SecondOpinion {
  source: 'neural';
  algorithm: string;
  framework: string;
  generatedAt: string;
  probability: number;
  riskPercent: number;
  riskBand: RiskBand;
  agreesWithPrimary: boolean;
  /** Signed band distance, neural minus tree, in band steps (-2..+2). */
  bandDelta: number;
  heldOutAccuracy: number;
  heldOutRecall: number;
  heldOutRocAuc: number;
  isPrototype: true;
}

export interface AttributionMeta {
  method: string;
  /** The comparison patient, feature by feature. */
  baseline: Record<string, number>;
  logit: number;
  baselineLogit: number;
  /** Residual of the completeness identity. Near zero; exposed for auditability. */
  completenessGap: number;
}

export interface RiskAssessmentResult {
  riskBand: RiskBand;
  probability: number;
  riskPercent: number;
  isHighRisk: boolean;
  features: ModelFeatures;
  derived: {
    bmi: number;
    bmiCategory: BmiCategory;
    glucoseCategory: GlucoseCategory;
    glucoseMeasurementType: GlucoseMeasurementType;
    diastolicBpCategory: DiastolicBpCategory;
  };
  /** Field names that were filled with a dataset median instead of a measurement. */
  imputedFields: string[];
  reasons: RiskReason[];
  recommendations: RiskRecommendation[];
  /** The tree's path. This is what decided `riskBand`. */
  decisionPath: DecisionPathStep[];
  /** Independent neural read on the same patient, or null if unavailable. */
  secondOpinion: SecondOpinion | null;
  /** Per-feature attributions from the neural model. Empty when unavailable. */
  attributions: FeatureAttribution[];
  attributionMeta: AttributionMeta | null;
  model: {
    engineVersion: string;
    /** Which model decided `riskBand`. Always 'tree' in this version. */
    primaryModel: 'tree';
    treeGeneratedAt: string;
    leafId: number;
    leafTrainingSamples: number;
    heldOutAccuracy: number;
    heldOutRecall: number;
    datasetName: string;
    datasetLimitation: string;
    isPrototype: true;
  };
}

export interface InputRange {
  min: number;
  max: number;
  unit: string;
}

export declare const RISK_ENGINE_VERSION: string;
export declare const RISK_BANDS: readonly RiskBand[];
export declare const GLUCOSE_MEASUREMENT_TYPES: Record<
  GlucoseMeasurementType,
  { prediabetes: number; diabetes: number }
>;
export declare const DEFAULT_GLUCOSE_MEASUREMENT_TYPE: GlucoseMeasurementType;
export declare const BMI_CATEGORIES: Record<BmiCategory, { min?: number; max?: number }>;
export declare const DIASTOLIC_BP_RANGES: { elevated: number; high: number };
export declare const SCREENING_AGE: { advisory: number; elevated: number };
export declare const INPUT_RANGES: Record<string, InputRange>;
export declare const FEATURE_ORDER: readonly string[];
export declare const IMPUTED_WHEN_MISSING: { skinThickness: number; insulin: number };

export declare const MODEL_META: {
  generatedAt: string;
  algorithm: string;
  hyperparameters: Record<string, unknown>;
  featureOrder: string[];
  imputationMedians: Record<string, number>;
  pedigreeThreshold: number;
  riskBands: { high: number; moderate: number };
  featureImportances: Record<string, number>;
  metrics: {
    train: Record<string, unknown>;
    test: {
      accuracy: number;
      precision: number;
      recall: number;
      specificity: number;
      f1: number;
      rocAuc: number;
      confusionMatrix: {
        truePositive: number;
        falsePositive: number;
        trueNegative: number;
        falseNegative: number;
      };
    };
  };
  dataset: { name: string; records: number; knownLimitation: string };
};

export declare function calculateBmi(heightCm: number, weightKg: number): number | null;
export declare function bmiCategory(bmi: number): BmiCategory;
export declare function glucoseCategory(
  glucoseMgDl: number,
  measurementType?: GlucoseMeasurementType,
): GlucoseCategory;
export declare function diastolicBpCategory(diastolicBpMmHg: number): DiastolicBpCategory;

export declare function validateAssessmentInput(input: Partial<AssessmentInput>): {
  valid: boolean;
  errors: ValidationError[];
};

export declare function buildFeatureVector(input: AssessmentInput): {
  vector: number[];
  features: ModelFeatures;
  imputedFields: string[];
  bmi: number;
};

export declare function assessDiabetesRisk(input: AssessmentInput): RiskAssessmentResult;

export declare const DECISION_TREE: Record<string, unknown>;
export declare function predictWithTree(featureVector: number[]): {
  probability: number;
  leafId: number;
  samples: number;
  path: DecisionPathStep[];
};
export declare function bandForProbability(probability: number): RiskBand;

/* --- Neural second opinion ------------------------------------------------ */

export declare const NEURAL_META: {
  generatedAt: string;
  generatedBy: string;
  framework: string;
  frameworkVersion: string;
  algorithm: string;
  role: 'second-opinion';
  authoritativeForRiskBand: false;
  hyperparameters: Record<string, unknown>;
  epochSelection: Record<string, unknown>;
  parameterCount: number;
  featureOrder: string[];
  standardisation: { mean: number[]; std: number[] };
  attributionBaseline: number[];
  attributionMethod: string;
  attributionMaxDepth: number;
  riskBands: { high: number; moderate: number };
  featureImportances: Record<string, number>;
  metrics: {
    train: Record<string, unknown>;
    test: {
      accuracy: number;
      precision: number;
      recall: number;
      specificity: number;
      f1: number;
      rocAuc: number;
      confusionMatrix: {
        truePositive: number;
        falsePositive: number;
        trueNegative: number;
        falseNegative: number;
      };
    };
  };
  heldOutBandSummary: Record<
    RiskBand,
    {
      patients: number;
      actualDiabetic: number;
      actualDiabeticRate: number | null;
      share: number;
    }
  >;
  dataset: {
    name: string;
    records: number;
    trainRecords: number;
    testRecords: number;
    knownLimitation: string;
  };
  crossCheck: Record<string, unknown>;
};

export declare const NEURAL_FEATURE_ORDER: readonly string[];
export declare const NEURAL_WEIGHTS: {
  l1: { weight: number[][]; bias: number[] };
  l2: { weight: number[][]; bias: number[] };
  out: { weight: number[][]; bias: number[] };
};

/** Synchronous forward pass. Safe to call in a form submit handler, offline. */
export declare function predictWithNetwork(featureVector: number[]): {
  probability: number;
  logit: number;
};

export declare function attributionsFor(
  featureVector: number[],
  options?: { maxDepth?: number },
): {
  attributions: Array<{
    feature: string;
    contribution: number;
    share: number;
    direction: AttributionDirection;
  }>;
  logit: number;
  baselineLogit: number;
  completenessGap: number;
  regionsVisited: number;
};

export declare function neuralBandForProbability(probability: number): RiskBand;
