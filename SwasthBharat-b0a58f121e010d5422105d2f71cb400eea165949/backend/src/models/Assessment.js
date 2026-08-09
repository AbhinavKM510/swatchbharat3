/**
 * One diabetes risk screening.
 *
 * Stores the raw inputs alongside the scored result. Keeping the inputs means the record
 * can be re-scored later against a retrained model without going back to the patient —
 * which matters, because the current model is a Pima-trained prototype that will be
 * replaced by one trained on Indian cohort data.
 *
 * `clientId` is a device-generated UUID and the idempotency key for offline sync. A
 * unique index on it is what makes replaying a sync batch safe.
 */

import mongoose from 'mongoose';

export const REVIEW_STATUSES = ['pending', 'acknowledged', 'consulted', 'closed'];

/** Raw form values exactly as the worker entered them. */
const assessmentInputSchema = new mongoose.Schema(
  {
    sex: { type: String, required: true, enum: ['female', 'male'] },
    age: { type: Number, required: true },
    glucoseMgDl: { type: Number, required: true },
    glucoseMeasurementType: {
      type: String,
      enum: ['fasting', 'ogtt2h', 'random'],
      default: 'fasting',
    },
    diastolicBpMmHg: { type: Number, required: true },
    heightCm: { type: Number, required: true },
    weightKg: { type: Number, required: true },
    familyHistoryDiabetes: { type: Boolean, required: true },
    pregnancies: { type: Number, default: 0 },
    /** Null when not measured in the field; the engine substitutes a dataset median. */
    skinThicknessMm: { type: Number, default: null },
    insulinMuUml: { type: Number, default: null },
  },
  { _id: false },
);

const reasonSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    severity: { type: String, required: true },
    i18nKey: { type: String, required: true },
    params: { type: mongoose.Schema.Types.Mixed, default: undefined },
    fallbackEn: { type: String, default: '' },
  },
  { _id: false },
);

const decisionStepSchema = new mongoose.Schema(
  {
    feature: { type: String, required: true },
    operator: { type: String, required: true },
    threshold: { type: Number, required: true },
    value: { type: Number, required: true },
  },
  { _id: false },
);

/**
 * One feature's signed contribution to the neural second opinion.
 *
 * `baseline` is stored alongside `value` deliberately. A contribution is measured against
 * the training-split median patient, so BMI 31 can contribute *negatively* (the Pima
 * cohort's median BMI is 32.3) while the reason list correctly calls the same BMI obese
 * against the Indian cut-off of 25. Persisting the baseline means the record can always be
 * rendered without that looking like a contradiction, even years later against a
 * retrained model with different medians.
 */
const attributionSchema = new mongoose.Schema(
  {
    feature: { type: String, required: true },
    /** Signed, in logit units. Sums to logit(patient) - logit(baseline). */
    contribution: { type: Number, required: true },
    /** Share of total absolute movement, 0..1. */
    share: { type: Number, required: true },
    direction: { type: String, enum: ['increases', 'decreases', 'neutral'], required: true },
    value: { type: Number, required: true },
    baseline: { type: Number, default: null },
    /** True when the value was a substituted median rather than a measurement. */
    imputed: { type: Boolean, default: false },
  },
  { _id: false },
);

/**
 * The neural model's independent read on the same patient.
 *
 * Stored but NOT authoritative — `riskBand` above comes from the decision tree. This is
 * kept because a disagreement between a depth-4 tree and a neural net means the patient
 * sits near a decision boundary, which is useful triage information for a doctor.
 */
const secondOpinionSchema = new mongoose.Schema(
  {
    source: { type: String, default: 'neural' },
    algorithm: String,
    framework: String,
    generatedAt: String,
    probability: Number,
    riskPercent: Number,
    riskBand: { type: String, enum: ['LOW', 'MODERATE', 'HIGH'] },
    agreesWithPrimary: Boolean,
    /** Signed band distance, neural minus tree, in band steps. */
    bandDelta: Number,
  },
  { _id: false },
);

const assessmentSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, unique: true, trim: true },

    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    /** Denormalised so a queued assessment can be matched to its patient during sync. */
    patientClientId: { type: String, required: true, index: true },

    phc: { type: mongoose.Schema.Types.ObjectId, ref: 'Phc', required: true, index: true },
    district: { type: String, required: true, trim: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    input: { type: assessmentInputSchema, required: true },

    riskBand: { type: String, required: true, enum: ['LOW', 'MODERATE', 'HIGH'], index: true },
    probability: { type: Number, required: true },
    riskPercent: { type: Number, required: true },

    derived: {
      bmi: Number,
      bmiCategory: String,
      glucoseCategory: String,
      glucoseMeasurementType: String,
      diastolicBpCategory: String,
    },

    /** Fields where a dataset median stood in for a real measurement. */
    imputedFields: [{ type: String }],

    reasons: [reasonSchema],
    recommendations: [{ code: String, i18nKey: String, _id: false }],
    /** The tree's path. This is what produced `riskBand`. */
    decisionPath: [decisionStepSchema],

    /**
     * Neural second opinion and its attributions. Both optional: records written before
     * engine 1.1.0 do not have them, and a screening must still succeed if the neural
     * artefact cannot be evaluated, so readers must tolerate null/empty.
     */
    secondOpinion: { type: secondOpinionSchema, default: null },
    attributions: [attributionSchema],

    /**
     * True when the tree and the network put this patient in different bands. Indexed and
     * stored flat rather than being derived from `secondOpinion.agreesWithPrimary` at query
     * time, so the doctor dashboard can count and filter on it cheaply — the same shape as
     * `bandMismatch` below.
     */
    modelDisagreement: { type: Boolean, default: false, index: true },

    model: {
      engineVersion: String,
      /** Which model decided `riskBand`. 'tree' in every current record. */
      primaryModel: { type: String, default: 'tree' },
      treeGeneratedAt: String,
      leafId: Number,
      leafTrainingSamples: Number,
      datasetName: String,
      isPrototype: { type: Boolean, default: true },
    },

    /** Device clock at capture. Can be well before syncedAt for offline records. */
    capturedAt: { type: Date, required: true, index: true },
    syncedAt: { type: Date, default: () => new Date() },

    /** How the record reached the server. Drives the "synced from offline" UI badge. */
    source: { type: String, enum: ['online', 'offline-sync'], default: 'online', index: true },

    /** Whether the worker typed the values or dictated them. */
    inputMethod: { type: String, enum: ['typed', 'voice', 'mixed'], default: 'typed' },

    language: { type: String, enum: ['bn', 'hi', 'en'], default: 'hi' },

    /**
     * The band the device calculated before syncing. The server always re-scores from
     * the raw inputs; if the two disagree the record is flagged rather than silently
     * overwritten, because a mismatch means the device is running a stale model bundle.
     */
    deviceRiskBand: { type: String, enum: ['LOW', 'MODERATE', 'HIGH', null], default: null },
    bandMismatch: { type: Boolean, default: false, index: true },

    /* Doctor workflow ----------------------------------------------------- */
    reviewStatus: { type: String, enum: REVIEW_STATUSES, default: 'pending', index: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, trim: true, default: '' },
  },
  { timestamps: true },
);

// The doctor dashboard's main query: this PHC's high-risk cases, newest first.
assessmentSchema.index({ phc: 1, riskBand: 1, capturedAt: -1 });
// The district officer's trend query.
assessmentSchema.index({ district: 1, capturedAt: -1 });

assessmentSchema.methods.toPublicJSON = function toPublicJSON() {
  const populatedPatient =
    this.populated('patient') && this.patient && typeof this.patient === 'object' && this.patient.name
      ? this.patient.toPublicJSON()
      : null;

  const populatedWorker =
    this.populated('createdBy') && this.createdBy && this.createdBy.name
      ? { id: this.createdBy._id.toString(), name: this.createdBy.name, phone: this.createdBy.phone }
      : null;

  return {
    id: this._id.toString(),
    clientId: this.clientId,
    patientId: this.patient ? String(this.patient._id || this.patient) : null,
    patientClientId: this.patientClientId,
    patient: populatedPatient,
    phcId: this.phc ? String(this.phc._id || this.phc) : null,
    district: this.district,
    createdBy: populatedWorker,
    input: this.input,
    riskBand: this.riskBand,
    probability: this.probability,
    riskPercent: this.riskPercent,
    derived: this.derived,
    imputedFields: this.imputedFields,
    reasons: this.reasons,
    recommendations: this.recommendations,
    decisionPath: this.decisionPath,
    secondOpinion: this.secondOpinion ?? null,
    attributions: this.attributions ?? [],
    modelDisagreement: Boolean(this.modelDisagreement),
    model: this.model,
    capturedAt: this.capturedAt,
    syncedAt: this.syncedAt,
    source: this.source,
    inputMethod: this.inputMethod,
    language: this.language,
    deviceRiskBand: this.deviceRiskBand,
    bandMismatch: this.bandMismatch,
    reviewStatus: this.reviewStatus,
    reviewedAt: this.reviewedAt,
    reviewNote: this.reviewNote,
    createdAt: this.createdAt,
  };
};

export const Assessment = mongoose.model('Assessment', assessmentSchema);
