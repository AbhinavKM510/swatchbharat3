/**
 * Assessment ingestion — the single code path for both the online POST and the offline
 * sync batch.
 *
 * Two properties matter here and they are the reason this is a service rather than
 * inline route code:
 *
 * 1. **Idempotency.** Offline records are replayed. A worker with flaky signal will send
 *    the same batch twice, and the sync queue retries on failure. Every write is keyed on
 *    the device-generated `clientId`, so a repeat is reported as `duplicate` instead of
 *    creating a second patient with a second high-risk alert.
 *
 * 2. **The server re-scores from raw inputs.** The device already computed a band offline,
 *    but the server never trusts it. It recomputes with the shared engine and records
 *    both. If they differ, the record is flagged (`bandMismatch`) — that means the device
 *    is running a stale model bundle, which is exactly the kind of drift that would
 *    otherwise go unnoticed.
 */

import { assessDiabetesRisk } from '../../../shared/risk/index.js';
import { Assessment } from '../models/Assessment.js';
import { Patient } from '../models/Patient.js';
import { sendHighRiskPush } from './pushService.js';
import { ApiError } from '../utils/ApiError.js';
import { isValidClientId, newClientId } from '../utils/ids.js';
import {
  REALTIME_EVENTS,
  emitToDistrict,
  emitToPhc,
} from '../realtime/io.js';

/** Number of reasons included in a real-time alert payload. */
const ALERT_REASON_COUNT = 3;

/**
 * Finds or creates the patient referenced by an incoming record.
 *
 * Upsert (not insert) because the device may have queued several assessments for the
 * same new patient while offline, and each one carries the full patient block.
 */
async function upsertPatient({ patient, user }) {
  if (!patient || typeof patient !== 'object') {
    throw ApiError.badRequest('PATIENT_REQUIRED', 'A patient block is required');
  }

  const clientId = String(patient.clientId || '').trim() || newClientId('pt');
  if (!isValidClientId(clientId)) {
    throw ApiError.badRequest('INVALID_PATIENT_CLIENT_ID', 'patient.clientId is not a valid identifier');
  }

  if (!patient.name || !String(patient.name).trim()) {
    throw ApiError.badRequest('PATIENT_NAME_REQUIRED', 'Patient name is required');
  }
  if (patient.sex !== 'female' && patient.sex !== 'male') {
    throw ApiError.badRequest('PATIENT_SEX_REQUIRED', 'Patient sex must be "female" or "male"');
  }

  const age = Number(patient.age);
  if (!Number.isFinite(age) || age < 0 || age > 120) {
    throw ApiError.badRequest('PATIENT_AGE_INVALID', 'Patient age must be between 0 and 120');
  }

  const phcId = user.phc?._id ?? user.phc;
  if (!phcId) {
    throw ApiError.badRequest(
      'NO_PHC_ASSIGNED',
      'Your account is not linked to a PHC, so records cannot be filed',
    );
  }

  const existing = await Patient.findOne({ clientId });
  if (existing) {
    // Keep the latest details the worker captured, but never let a record move to a
    // different PHC or a different owner after the fact.
    existing.name = String(patient.name).trim();
    existing.age = age;
    existing.sex = patient.sex;
    if (patient.phone !== undefined) existing.phone = String(patient.phone || '').trim();
    if (patient.village !== undefined) existing.village = String(patient.village || '').trim();
    await existing.save();
    return existing;
  }

  return Patient.create({
    clientId,
    name: String(patient.name).trim(),
    age,
    sex: patient.sex,
    phone: String(patient.phone || '').trim(),
    village: String(patient.village || '').trim(),
    phc: phcId,
    district: user.district,
    createdBy: user._id,
    capturedAt: patient.capturedAt ? new Date(patient.capturedAt) : new Date(),
  });
}

/** Compact payload for a real-time dashboard alert. */
function buildAlertPayload({ assessment, patient, user }) {
  return {
    assessmentId: assessment._id.toString(),
    clientId: assessment.clientId,
    riskBand: assessment.riskBand,
    riskPercent: assessment.riskPercent,
    patient: {
      id: patient._id.toString(),
      name: patient.name,
      age: patient.age,
      sex: patient.sex,
      village: patient.village,
    },
    topReasons: assessment.reasons.slice(0, ALERT_REASON_COUNT).map((reason) => ({
      code: reason.code,
      severity: reason.severity,
      i18nKey: reason.i18nKey,
      params: reason.params,
      fallbackEn: reason.fallbackEn,
    })),
    derived: assessment.derived,
    capturedAt: assessment.capturedAt,
    syncedAt: assessment.syncedAt,
    source: assessment.source,
    inputMethod: assessment.inputMethod,
    reviewStatus: assessment.reviewStatus,
    bandMismatch: assessment.bandMismatch,
    /**
     * Carried on the alert so a socket-delivered queue card renders identically to one
     * that arrived from a fetch. The dashboard shows a tag when the two models disagree;
     * omitting these here would make live-arrived cards silently miss it, which is exactly
     * the kind of inconsistency a reviewer notices.
     *
     * The full `attributions` array is deliberately NOT included — the queue card does not
     * show it, and it would roughly double the size of every alert.
     */
    modelDisagreement: Boolean(assessment.modelDisagreement),
    secondOpinion: assessment.secondOpinion
      ? {
          riskBand: assessment.secondOpinion.riskBand,
          riskPercent: assessment.secondOpinion.riskPercent,
          agreesWithPrimary: assessment.secondOpinion.agreesWithPrimary,
          bandDelta: assessment.secondOpinion.bandDelta,
        }
      : null,
    reportedBy: { id: user._id.toString(), name: user.name },
    phcId: String(assessment.phc),
    district: assessment.district,
  };
}

/**
 * Scores and stores one assessment.
 *
 * @param {object} args
 * @param {object} args.record  incoming record (clientId, patient, input, capturedAt, ...)
 * @param {object} args.user    authenticated field worker
 * @param {'online'|'offline-sync'} args.source
 * @param {boolean} [args.emitEvents=true]
 * @returns {Promise<{status: 'created'|'duplicate', assessment: object, patient: object}>}
 */
export async function ingestAssessment({ record, user, source, emitEvents = true }) {
  if (!record || typeof record !== 'object') {
    throw ApiError.badRequest('RECORD_REQUIRED', 'An assessment record is required');
  }

  const clientId = String(record.clientId || '').trim() || newClientId('as');
  if (!isValidClientId(clientId)) {
    throw ApiError.badRequest('INVALID_CLIENT_ID', 'clientId is not a valid identifier');
  }

  // Idempotency check before doing any work.
  const alreadyStored = await Assessment.findOne({ clientId }).populate('patient');
  if (alreadyStored) {
    return {
      status: 'duplicate',
      assessment: alreadyStored,
      patient: alreadyStored.patient,
    };
  }

  const patient = await upsertPatient({ patient: record.patient, user });

  // Age and sex live on the patient; the model needs them as features. Take them from the
  // patient record so the two can never disagree.
  const input = {
    ...record.input,
    age: record.input?.age ?? patient.age,
    sex: record.input?.sex ?? patient.sex,
  };

  // Throws with code VALIDATION_FAILED; the error handler turns that into a 400 with
  // per-field details the translated form can render.
  const result = assessDiabetesRisk(input);

  const deviceRiskBand = ['LOW', 'MODERATE', 'HIGH'].includes(record.deviceRiskBand)
    ? record.deviceRiskBand
    : null;

  const capturedAt = record.capturedAt ? new Date(record.capturedAt) : new Date();
  if (Number.isNaN(capturedAt.getTime())) {
    throw ApiError.badRequest('INVALID_CAPTURED_AT', 'capturedAt is not a valid date');
  }

  const document = {
    clientId,
    patient: patient._id,
    patientClientId: patient.clientId,
    phc: user.phc?._id ?? user.phc,
    district: user.district,
    createdBy: user._id,
    input: {
      sex: input.sex,
      age: Number(input.age),
      glucoseMgDl: Number(input.glucoseMgDl),
      glucoseMeasurementType: result.derived.glucoseMeasurementType,
      diastolicBpMmHg: Number(input.diastolicBpMmHg),
      heightCm: Number(input.heightCm),
      weightKg: Number(input.weightKg),
      familyHistoryDiabetes: Boolean(input.familyHistoryDiabetes),
      pregnancies: result.features.pregnancies,
      skinThicknessMm:
        input.skinThicknessMm === undefined || input.skinThicknessMm === null || input.skinThicknessMm === ''
          ? null
          : Number(input.skinThicknessMm),
      insulinMuUml:
        input.insulinMuUml === undefined || input.insulinMuUml === null || input.insulinMuUml === ''
          ? null
          : Number(input.insulinMuUml),
    },
    riskBand: result.riskBand,
    probability: result.probability,
    riskPercent: result.riskPercent,
    derived: result.derived,
    imputedFields: result.imputedFields,
    reasons: result.reasons,
    recommendations: result.recommendations,
    decisionPath: result.decisionPath,
    /**
     * The neural second opinion, as re-computed here on the server. Not taken from the
     * device: the whole point of re-scoring is that the server's own model is the record
     * of what was decided. Null when the neural artefact could not be evaluated, which
     * never blocks the screening.
     */
    secondOpinion: result.secondOpinion ?? null,
    attributions: result.attributions ?? [],
    modelDisagreement: Boolean(result.secondOpinion && !result.secondOpinion.agreesWithPrimary),
    model: {
      engineVersion: result.model.engineVersion,
      primaryModel: result.model.primaryModel ?? 'tree',
      treeGeneratedAt: result.model.treeGeneratedAt,
      leafId: result.model.leafId,
      leafTrainingSamples: result.model.leafTrainingSamples,
      datasetName: result.model.datasetName,
      isPrototype: true,
    },
    capturedAt,
    syncedAt: new Date(),
    source,
    inputMethod: ['typed', 'voice', 'mixed'].includes(record.inputMethod) ? record.inputMethod : 'typed',
    language: ['bn', 'hi', 'en'].includes(record.language) ? record.language : user.language,
    deviceRiskBand,
    bandMismatch: Boolean(deviceRiskBand && deviceRiskBand !== result.riskBand),
  };

  let assessment;
  try {
    assessment = await Assessment.create(document);
  } catch (error) {
    // Two devices (or two retries) racing on the same clientId. The unique index is the
    // arbiter; whoever lost just reports a duplicate.
    if (error?.code === 11000) {
      const winner = await Assessment.findOne({ clientId }).populate('patient');
      if (winner) return { status: 'duplicate', assessment: winner, patient: winner.patient };
    }
    throw error;
  }

  if (emitEvents) {
    const payload = buildAlertPayload({ assessment, patient, user });
    const phcId = String(document.phc);

    emitToPhc(phcId, REALTIME_EVENTS.ASSESSMENT_CREATED, payload);
    emitToDistrict(user.district, REALTIME_EVENTS.ASSESSMENT_CREATED, payload);

    if (assessment.riskBand === 'HIGH') {
      emitToPhc(phcId, REALTIME_EVENTS.HIGH_RISK_ALERT, payload);
      emitToDistrict(user.district, REALTIME_EVENTS.HIGH_RISK_ALERT, payload);

      /**
       * Background push, for the doctor whose dashboard is CLOSED. Socket.io above only
       * reaches an open tab.
       *
       * Deliberately fire-and-forget, and deliberately not awaited. The assessment is
       * already stored and the caller is about to be told it succeeded; making a health
       * worker in a village wait on — or worse, see an error from — Google's messaging
       * service would be the wrong trade entirely. `sendHighRiskPush` also swallows its own
       * errors, so this is belt and braces.
       *
       * The recipient list is computed inside that function from the database, by PHC. No
       * part of it comes from this payload or from any client.
       */
      void sendHighRiskPush({ assessment, patient, phcId }).catch(() => undefined);
    }
  }

  return { status: 'created', assessment, patient };
}

/**
 * Processes a sync batch.
 *
 * Every record is attempted independently: one bad record (a typo'd glucose from three
 * days ago) must not block the other nine from syncing, or the worker's queue jams
 * forever. The response reports each record's outcome so the device knows exactly which
 * entries to clear from its local queue and which to surface for correction.
 *
 * @param {object} args
 * @param {object[]} args.records
 * @param {object} args.user
 * @returns {Promise<{summary: object, results: object[]}>}
 */
export async function ingestAssessmentBatch({ records, user }) {
  if (!Array.isArray(records)) {
    throw ApiError.badRequest('RECORDS_REQUIRED', 'Body must contain a "records" array');
  }
  if (records.length === 0) {
    return { summary: { total: 0, created: 0, duplicates: 0, failed: 0, highRisk: 0 }, results: [] };
  }
  if (records.length > 200) {
    throw ApiError.badRequest(
      'BATCH_TOO_LARGE',
      'Send at most 200 records per sync request so a failure does not lose a large batch',
    );
  }

  const results = [];
  const summary = { total: records.length, created: 0, duplicates: 0, failed: 0, highRisk: 0 };

  for (const record of records) {
    const clientId = record?.clientId ?? null;
    try {
      const { status, assessment } = await ingestAssessment({
        record,
        user,
        source: 'offline-sync',
      });

      if (status === 'created') {
        summary.created += 1;
        if (assessment.riskBand === 'HIGH') summary.highRisk += 1;
      } else {
        summary.duplicates += 1;
      }

      results.push({
        clientId,
        status,
        assessmentId: assessment._id.toString(),
        // The device has no server-side patient id until this comes back. Without it,
        // booking a teleconsult after sync has nothing valid to send as patientId.
        patientId: assessment.patient ? String(assessment.patient._id ?? assessment.patient) : null,
        riskBand: assessment.riskBand,
        riskPercent: assessment.riskPercent,
        bandMismatch: assessment.bandMismatch,
      });
    } catch (error) {
      summary.failed += 1;
      results.push({
        clientId,
        status: 'failed',
        error: {
          code: error?.code === 'VALIDATION_FAILED' ? 'VALIDATION_FAILED' : error?.code || 'INGEST_FAILED',
          message: error?.message || 'Could not store this record',
          ...(Array.isArray(error?.validationErrors) ? { fields: error.validationErrors } : {}),
          ...(error?.details ? { details: error.details } : {}),
        },
      });
    }
  }

  return { summary, results };
}
