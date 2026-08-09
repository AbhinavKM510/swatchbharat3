/** Shared response shapes for the SwasthBharat API. */

import type {
  DecisionPathStep,
  FeatureAttribution,
  RiskBand,
  RiskReason,
  RiskRecommendation,
  SecondOpinion,
} from '@shared/risk/index.js';

export type Role = 'asha' | 'doctor' | 'officer';
export type Sex = 'female' | 'male';
export type GlucoseMeasurementType = 'fasting' | 'ogtt2h' | 'random';
export type ReviewStatus = 'pending' | 'acknowledged' | 'consulted' | 'closed';
export type TeleconsultStatus = 'requested' | 'connecting' | 'in-call' | 'completed' | 'cancelled';
export type InputMethod = 'typed' | 'voice' | 'mixed';
export type RecordSource = 'online' | 'offline-sync';

export interface Phc {
  id: string;
  code: string;
  name: string;
  block: string;
  district: string;
  state: string;
  villages: string[];
  location: { lat: number | null; lng: number | null };
  contactPhone: string;
}

/**
 * The trimmed PHC shape returned by the public `/api/auth/phcs` list.
 *
 * Deliberately not `Pick<Phc, ...>`: that would tie this to a type describing the
 * authenticated payload, and widening `Phc` later would silently claim this public endpoint
 * returns fields it does not. Separate shape, separate contract.
 */
export interface PhcOption {
  code: string;
  name: string;
  block: string;
  district: string;
}

export interface User {
  id: string;
  name: string;
  phone: string;
  role: Role;
  language: 'bn' | 'hi' | 'en';
  district: string;
  villages: string[];
  phcId: string | null;
  phc: Phc | null;
  isActive: boolean;
  lastLoginAt: string | null;
}

export interface Patient {
  id: string;
  clientId: string;
  name: string;
  age: number;
  sex: Sex;
  phone: string;
  village: string;
  phcId: string | null;
  district: string;
  capturedAt: string;
  createdAt: string;
}

/** Raw form values, exactly as captured. */
export interface AssessmentFormInput {
  sex: Sex;
  age: number;
  glucoseMgDl: number;
  glucoseMeasurementType: GlucoseMeasurementType;
  diastolicBpMmHg: number;
  heightCm: number;
  weightKg: number;
  familyHistoryDiabetes: boolean;
  pregnancies: number;
  skinThicknessMm: number | null;
  insulinMuUml: number | null;
}

export interface Assessment {
  id: string;
  clientId: string;
  patientId: string | null;
  patientClientId: string;
  patient: Patient | null;
  phcId: string | null;
  district: string;
  createdBy: { id: string; name: string; phone: string } | null;
  input: AssessmentFormInput;
  riskBand: RiskBand;
  probability: number;
  riskPercent: number;
  derived: {
    bmi: number;
    bmiCategory: string;
    glucoseCategory: string;
    glucoseMeasurementType: GlucoseMeasurementType;
    diastolicBpCategory: string;
  };
  imputedFields: string[];
  reasons: RiskReason[];
  recommendations: RiskRecommendation[];
  decisionPath: DecisionPathStep[];
  /**
   * Neural second opinion. Optional because records written before engine 1.1.0 do not
   * have it, and because a screening succeeds even when the neural artefact cannot be
   * evaluated. Never assume it is present.
   */
  secondOpinion?: SecondOpinion | null;
  attributions?: FeatureAttribution[];
  /** True when the tree and the network disagreed on the band. Not a fault — a shortlist. */
  modelDisagreement?: boolean;
  model: {
    engineVersion: string;
    primaryModel?: string;
    treeGeneratedAt: string;
    leafId: number;
    leafTrainingSamples: number;
    datasetName: string;
    isPrototype: boolean;
  };
  capturedAt: string;
  syncedAt: string;
  source: RecordSource;
  inputMethod: InputMethod;
  language: 'bn' | 'hi' | 'en';
  deviceRiskBand: RiskBand | null;
  bandMismatch: boolean;
  reviewStatus: ReviewStatus;
  reviewedAt: string | null;
  reviewNote: string;
  createdAt: string;
}

/** Compact payload pushed over Socket.io when a patient is flagged. */
export interface HighRiskAlert {
  assessmentId: string;
  clientId: string;
  riskBand: RiskBand;
  riskPercent: number;
  patient: { id: string; name: string; age: number; sex: Sex; village: string };
  topReasons: RiskReason[];
  derived: Assessment['derived'];
  capturedAt: string;
  syncedAt: string;
  source: RecordSource;
  inputMethod: InputMethod;
  reviewStatus: ReviewStatus;
  bandMismatch: boolean;
  /**
   * Carried on the alert so a live-arrived queue card shows the same tags as a fetched
   * one. The full attribution array is deliberately not sent — the card does not use it.
   */
  modelDisagreement?: boolean;
  secondOpinion?: Pick<
    SecondOpinion,
    'riskBand' | 'riskPercent' | 'agreesWithPrimary' | 'bandDelta'
  > | null;
  reportedBy: { id: string; name: string };
  phcId: string;
  district: string;
}

export interface DashboardSummary {
  totals: { assessments: number; patients: number; today: number; last7Days: number };
  byBand: Record<RiskBand, number>;
  highRiskRate: number;
  queue: { openHighRisk: number };
  dataQuality: {
    bandMismatches: number;
    syncedFromOffline: number;
    offlineShare: number;
    /** Optional: absent from a server running an older engine. */
    modelDisagreements?: number;
    modelDisagreementShare?: number;
  };
  realtime: { enabled: boolean; connectedSockets: number; byRole?: Record<string, number> };
  scope: { role: Role; phcId: string | null; district: string };
  generatedAt: string;
}

export interface DistrictTrends {
  district: string;
  window: { days: number; since: string };
  allTimeByBand: Record<RiskBand, number>;
  dailySeries: { date: string; LOW: number; MODERATE: number; HIGH: number; total: number }[];
  perPhc: {
    phcId: string;
    code: string;
    name: string;
    block: string;
    total: number;
    high: number;
    moderate: number;
    low: number;
    openHighRisk: number;
    highRiskRate: number;
    avgGlucose: number | null;
    avgBmi: number | null;
    lastCapturedAt: string;
  }[];
  topRiskFactors: { code: string; count: number }[];
  byAgeBand: { band: string; total: number; high: number; highRiskRate: number }[];
  adoption: {
    assessments: number;
    voiceEntryShare: number;
    offlineCaptureShare: number;
    languageShare: { bn: number; hi: number; en: number };
  };
  generatedAt: string;
}

export interface Teleconsult {
  id: string;
  clientId: string;
  patientId: string | null;
  patient: Patient | null;
  assessmentId: string | null;
  phcId: string | null;
  district: string;
  reason: string;
  preferredLanguage: 'bn' | 'hi' | 'en';
  status: TeleconsultStatus;
  sessionId: string;
  isSimulated: boolean;
  simulationNotice: string;
  requestedAt: string;
  completedAt: string | null;
  durationSeconds: number | null;
  notes: string;
}

export interface ModelCard {
  engineVersion: string;
  disease: string;
  isPrototype: boolean;
  algorithm: string;
  hyperparameters: Record<string, unknown>;
  trainedAt: string;
  featureOrder: string[];
  featureImportances: Record<string, number>;
  imputationMedians: Record<string, number>;
  riskBands: { high: number; moderate: number };
  metrics: {
    train: Record<string, unknown>;
    test: {
      accuracy: number;
      precision: number;
      recall: number;
      specificity: number;
      f1: number;
      rocAuc: number;
      confusionMatrix: Record<string, number>;
    };
  };
  dataset: { name: string; records: number; knownLimitation: string };
  limitations: string[];
  explanationReferences: Record<string, string>;
  inputRanges: Record<string, { min: number; max: number; unit: string }>;
  /** Which model decides the risk band. Optional: absent from an older server. */
  primaryModel?: string;
  /**
   * The neural second opinion's own card. Optional for the same reason — and the page must
   * fall back to the bundled NEURAL_META so this section still renders offline.
   */
  secondOpinion?: {
    role: string;
    authoritativeForRiskBand: boolean;
    algorithm: string;
    framework: string;
    parameterCount: number;
    hyperparameters: Record<string, unknown>;
    trainedAt: string;
    featureImportances: Record<string, number>;
    metrics: ModelCard['metrics'];
    heldOutBandSummary: Record<
      RiskBand,
      { patients: number; actualDiabetic: number; actualDiabeticRate: number | null; share: number }
    >;
    attributionMethod: string;
    attributionBaseline: Record<string, number>;
    metricsMeasuredBy: string;
    crossCheck: Record<string, unknown>;
    limitations: string[];
  };
}

export interface SyncResultEntry {
  clientId: string | null;
  status: 'created' | 'duplicate' | 'failed';
  assessmentId?: string;
  /** Server-side patient id, needed to book a teleconsult once this record has synced. */
  patientId?: string | null;
  riskBand?: RiskBand;
  riskPercent?: number;
  bandMismatch?: boolean;
  error?: {
    code: string;
    message: string;
    fields?: { field: string; code: string; i18nKey: string; params?: Record<string, unknown> }[];
  };
}

export interface SyncResponse {
  summary: { total: number; created: number; duplicates: number; failed: number; highRisk: number };
  results: SyncResultEntry[];
  syncedAt: string;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  hasMore: boolean;
}
