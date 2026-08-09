/**
 * Teleconsultation booking — SIMULATED.
 *
 * ### Be straight about this one
 *
 * What is real: the booking request, the doctor-side queue, the status transitions, the
 * real-time notification to the PHC dashboard, and the record that a consult was asked
 * for. All of that is genuine backend behaviour.
 *
 * What is NOT real: the call. There is no WebRTC peer connection, no Twilio, no media
 * server, no TURN relay. `sessionId` is a UUID prefixed `sim-` and connects to nothing.
 * The frontend shows a "connecting..." animation and a call layout on a timer.
 *
 * Every response carries `isSimulated: true` and a `simulationNotice` string so the
 * limitation is impossible to miss, including for anyone reading the API rather than the
 * pitch deck.
 *
 * ### Identifying the patient
 *
 * `POST /` accepts EITHER `patientId` (the server ObjectId, available once the record
 * has synced) OR `patientClientId` (the UUID the device generated before it had any
 * network connection). The second one exists so a worker who screened a patient while
 * offline can book a consultation as soon as they regain signal, without waiting for
 * the sync round trip that assigns a server id. If both are sent, `patientId` wins.
 */

import express from 'express';
import { Assessment } from '../models/Assessment.js';
import { Patient } from '../models/Patient.js';
import { TeleconsultRequest } from '../models/TeleconsultRequest.js';
import { assertCanAccessRecord, requireAuth, requireRole, scopeFilterFor } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { isValidClientId, newClientId, newSimulatedSessionId } from '../utils/ids.js';
import { REALTIME_EVENTS, emitToPhc } from '../realtime/io.js';

export const teleconsultRouter = express.Router();

teleconsultRouter.use(requireAuth);

const SIMULATION_NOTICE =
  'Demo only: no real call is placed. Booking, queue and notifications are real; the video call is simulated.';

teleconsultRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { patientId, patientClientId, assessmentId, reason = '', preferredLanguage } = req.body || {};

    const clientId = String(req.body?.clientId || '').trim() || newClientId('tc');
    if (!isValidClientId(clientId)) {
      throw ApiError.badRequest('INVALID_CLIENT_ID', 'clientId is not a valid identifier');
    }

    // Idempotent, same as assessments: a worker tapping "Book" twice on a slow connection
    // must not create two requests.
    const existing = await TeleconsultRequest.findOne({ clientId }).populate('patient');
    if (existing) {
      res.status(200).json({ status: 'duplicate', teleconsult: existing.toPublicJSON() });
      return;
    }

    // Two ways to name the patient, because there are two states a device can be in.
    //
    //   patientId       the server's ObjectId. Only exists once the record has synced.
    //   patientClientId the UUID the device generated before any network call.
    //
    // A worker who was offline for the whole visit has only the second one, yet the UI
    // wants to offer "book consultation" the moment they are back online — before the
    // sync round trip that would populate a patientId. Resolving by `clientId` removes
    // that special case instead of adding one: `clientId` is already the identity the
    // rest of the offline system is built on (see the Patient model).
    //
    // `patientId` wins if both are sent, since it is the more specific reference.
    const trimmedPatientClientId = String(patientClientId ?? '').trim();
    let patient = null;

    if (patientId) {
      patient = await Patient.findById(patientId);
    } else if (trimmedPatientClientId) {
      if (!isValidClientId(trimmedPatientClientId)) {
        throw ApiError.badRequest(
          'INVALID_CLIENT_ID',
          'patientClientId is not a valid identifier',
        );
      }
      patient = await Patient.findOne({ clientId: trimmedPatientClientId });
    } else {
      throw ApiError.badRequest(
        'PATIENT_REFERENCE_REQUIRED',
        'Provide either patientId (synced record) or patientClientId (device id, not yet synced)',
      );
    }

    if (!patient) throw ApiError.notFound('PATIENT_NOT_FOUND', 'No such patient');
    assertCanAccessRecord(req.user, patient);

    let assessment = null;
    if (assessmentId) {
      assessment = await Assessment.findById(assessmentId);
      if (!assessment) throw ApiError.notFound('ASSESSMENT_NOT_FOUND', 'No such screening record');
      assertCanAccessRecord(req.user, assessment);
    }

    const teleconsult = await TeleconsultRequest.create({
      clientId,
      patient: patient._id,
      assessment: assessment?._id ?? null,
      phc: patient.phc,
      district: patient.district,
      requestedBy: req.user._id,
      reason: String(reason).slice(0, 500),
      preferredLanguage: ['bn', 'hi', 'en'].includes(preferredLanguage)
        ? preferredLanguage
        : req.user.language,
      status: 'requested',
      sessionId: newSimulatedSessionId(),
      isSimulated: true,
    });

    await teleconsult.populate('patient');

    emitToPhc(String(patient.phc), REALTIME_EVENTS.TELECONSULT_REQUESTED, {
      teleconsultId: teleconsult._id.toString(),
      patient: { id: patient._id.toString(), name: patient.name, age: patient.age, village: patient.village },
      riskBand: assessment?.riskBand ?? null,
      reason: teleconsult.reason,
      preferredLanguage: teleconsult.preferredLanguage,
      requestedAt: teleconsult.requestedAt,
      requestedBy: { id: req.user._id.toString(), name: req.user.name },
      isSimulated: true,
    });

    res.status(201).json({
      status: 'created',
      teleconsult: teleconsult.toPublicJSON(),
      simulationNotice: SIMULATION_NOTICE,
    });
  }),
);

/** Requests visible to the caller: their own if a worker, the whole PHC if a doctor. */
teleconsultRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = req.user.role === 'asha' ? { requestedBy: req.user._id } : scopeFilterFor(req.user);
    if (req.query.status) filter.status = String(req.query.status);

    const items = await TeleconsultRequest.find(filter)
      .sort({ requestedAt: -1 })
      .limit(100)
      .populate('patient');

    res.json({
      items: items.map((item) => item.toPublicJSON()),
      simulationNotice: SIMULATION_NOTICE,
    });
  }),
);

/**
 * Status transition. The frontend walks requested -> connecting -> in-call -> completed
 * on a timer to produce the demo call flow; a doctor can also pick up or cancel.
 */
teleconsultRouter.patch(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const { status, notes = '', durationSeconds } = req.body || {};
    const allowed = ['requested', 'connecting', 'in-call', 'completed', 'cancelled'];

    if (!allowed.includes(status)) {
      throw ApiError.badRequest('STATUS_INVALID', `status must be one of: ${allowed.join(', ')}`);
    }

    const teleconsult = await TeleconsultRequest.findById(req.params.id).populate('patient');
    if (!teleconsult) throw ApiError.notFound('TELECONSULT_NOT_FOUND', 'No such teleconsultation request');

    const isOwner = String(teleconsult.requestedBy) === req.user._id.toString();
    const sameSection = String(teleconsult.phc) === String(req.user.phc?._id ?? req.user.phc);
    if (!isOwner && !(req.user.role === 'doctor' && sameSection)) {
      throw ApiError.forbidden('OUT_OF_SCOPE', 'This request is outside your assigned area');
    }

    teleconsult.status = status;
    if (notes) teleconsult.notes = String(notes).slice(0, 1000);
    if (req.user.role === 'doctor' && !teleconsult.doctor) teleconsult.doctor = req.user._id;
    if (status === 'completed') {
      teleconsult.completedAt = new Date();
      if (Number.isFinite(Number(durationSeconds))) {
        teleconsult.durationSeconds = Number(durationSeconds);
      }
    }
    await teleconsult.save();

    res.json({ teleconsult: teleconsult.toPublicJSON(), simulationNotice: SIMULATION_NOTICE });
  }),
);

/**
 * Documents what is faked, as an endpoint rather than only a comment.
 *
 * The frontend renders this on the teleconsult screen so a judge tapping through the demo
 * sees the disclosure without having to ask.
 */
teleconsultRouter.get('/capabilities', requireRole('asha', 'doctor', 'officer'), (_req, res) => {
  res.json({
    videoCall: { implemented: false, note: 'UI only. No WebRTC/Twilio integration in this build.' },
    booking: { implemented: true, note: 'Requests are stored, queued and pushed to the PHC dashboard live.' },
    smsFallback: {
      implemented: false,
      note: 'Designed for, not integrated. Would need a licensed SMS gateway (e.g. an Indian DLT-registered sender).',
    },
    abdmLinkage: {
      implemented: false,
      note: 'ABDM/NDHM health-ID interoperability is out of scope for this build.',
    },
    simulationNotice: SIMULATION_NOTICE,
  });
});
