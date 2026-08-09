/**
 * Screening records: create, sync a batch from offline storage, read, review.
 */

import express from 'express';
import { assessDiabetesRisk } from '../../../shared/risk/index.js';
import { Assessment } from '../models/Assessment.js';
import { assertCanAccessRecord, requireAuth, requireRole, scopeFilterFor } from '../middleware/auth.js';
import { ingestAssessment, ingestAssessmentBatch } from '../services/assessmentService.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { REALTIME_EVENTS, emitToPhc, emitToUser } from '../realtime/io.js';

export const assessmentsRouter = express.Router();

assessmentsRouter.use(requireAuth);

/**
 * Score without storing.
 *
 * Exists so the app can show a preview, and so the scoring can be checked from curl
 * without polluting the database. Note the PWA does not depend on this: it runs the same
 * engine locally, which is what makes offline screening possible at all.
 */
assessmentsRouter.post(
  '/score',
  asyncHandler(async (req, res) => {
    const result = assessDiabetesRisk(req.body || {});
    res.json({ result, stored: false });
  }),
);

/** Create one screening (device is online). */
assessmentsRouter.post(
  '/',
  requireRole('asha', 'doctor'),
  asyncHandler(async (req, res) => {
    const { status, assessment } = await ingestAssessment({
      record: req.body || {},
      user: req.user,
      source: 'online',
    });

    await assessment.populate('patient');

    res.status(status === 'created' ? 201 : 200).json({
      status,
      assessment: assessment.toPublicJSON(),
    });
  }),
);

/**
 * Sync a batch of records captured while offline.
 *
 * The device sends everything still in its queue. The response tells it, per record,
 * whether to clear the entry (`created` / `duplicate`) or keep it for the worker to fix
 * (`failed`). Replaying the same batch is safe.
 */
assessmentsRouter.post(
  '/sync',
  requireRole('asha', 'doctor'),
  asyncHandler(async (req, res) => {
    const { records } = req.body || {};
    const { summary, results } = await ingestAssessmentBatch({ records, user: req.user });

    // Let the worker's own devices know the queue drained, so a second tab updates too.
    emitToUser(req.user._id, REALTIME_EVENTS.SYNC_COMPLETED, {
      summary,
      syncedAt: new Date().toISOString(),
    });

    res.json({ summary, results, syncedAt: new Date().toISOString() });
  }),
);

/**
 * List screenings visible to the caller.
 *
 * Scope comes from `scopeFilterFor`, so an ASHA worker sees only their own records and a
 * doctor sees their whole PHC, without either route or client asking for it.
 */
assessmentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { band, status, patientId, since, mine, limit = 50, page = 1 } = req.query;

    const filter = { ...scopeFilterFor(req.user) };

    /**
     * `mine=true` narrows the result to records this user personally created.
     *
     * Added for the device restore: the PWA stores the worker's own screenings in IndexedDB
     * and needs them back after a logout wipes the local copy. Without this a DOCTOR — whose
     * scope is the whole PHC — would pull every colleague's patients onto their handset, which
     * is both useless to them and a lot of patient data to leave on a device.
     *
     * It can only ever REMOVE rows from what `scopeFilterFor` already permits, never add any:
     * the two conditions are ANDed, and this one is strictly narrower. So it is not a way to
     * reach another PHC's records.
     */
    if (String(mine) === 'true') filter.createdBy = req.user._id;
    if (band) {
      const bands = String(band)
        .split(',')
        .map((b) => b.trim().toUpperCase())
        .filter((b) => ['LOW', 'MODERATE', 'HIGH'].includes(b));
      if (bands.length > 0) filter.riskBand = { $in: bands };
    }
    if (status) filter.reviewStatus = String(status);
    if (patientId) filter.patient = String(patientId);
    if (since) {
      const sinceDate = new Date(String(since));
      if (!Number.isNaN(sinceDate.getTime())) filter.capturedAt = { $gte: sinceDate };
    }

    const perPage = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    const currentPage = Math.max(Number.parseInt(page, 10) || 1, 1);

    const [items, total] = await Promise.all([
      Assessment.find(filter)
        .sort({ capturedAt: -1 })
        .skip((currentPage - 1) * perPage)
        .limit(perPage)
        .populate('patient')
        .populate('createdBy', 'name phone'),
      Assessment.countDocuments(filter),
    ]);

    res.json({
      items: items.map((item) => item.toPublicJSON()),
      page: currentPage,
      perPage,
      total,
      hasMore: currentPage * perPage < total,
    });
  }),
);

assessmentsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const assessment = await Assessment.findById(req.params.id)
      .populate('patient')
      .populate('createdBy', 'name phone');

    if (!assessment) throw ApiError.notFound('ASSESSMENT_NOT_FOUND', 'No such screening record');
    assertCanAccessRecord(req.user, assessment);

    res.json({ assessment: assessment.toPublicJSON() });
  }),
);

/**
 * Doctor triage action.
 *
 * The review status is what turns the dashboard from a list into a worklist: a doctor
 * marks a flagged case acknowledged, then consulted, then closed. The change is pushed
 * back over Socket.io so a second doctor viewing the same PHC does not pick up a case
 * that has already been handled.
 */
assessmentsRouter.patch(
  '/:id/review',
  requireRole('doctor'),
  asyncHandler(async (req, res) => {
    const { reviewStatus, reviewNote = '' } = req.body || {};
    const allowed = ['pending', 'acknowledged', 'consulted', 'closed'];

    if (!allowed.includes(reviewStatus)) {
      throw ApiError.badRequest('REVIEW_STATUS_INVALID', `reviewStatus must be one of: ${allowed.join(', ')}`);
    }

    const assessment = await Assessment.findById(req.params.id).populate('patient');
    if (!assessment) throw ApiError.notFound('ASSESSMENT_NOT_FOUND', 'No such screening record');
    assertCanAccessRecord(req.user, assessment);

    assessment.reviewStatus = reviewStatus;
    assessment.reviewNote = String(reviewNote).slice(0, 1000);
    assessment.reviewedBy = req.user._id;
    assessment.reviewedAt = new Date();
    await assessment.save();

    const payload = {
      assessmentId: assessment._id.toString(),
      reviewStatus: assessment.reviewStatus,
      reviewNote: assessment.reviewNote,
      reviewedAt: assessment.reviewedAt,
      reviewedBy: { id: req.user._id.toString(), name: req.user.name },
    };
    emitToPhc(String(assessment.phc), REALTIME_EVENTS.ASSESSMENT_REVIEWED, payload);

    res.json({ assessment: assessment.toPublicJSON() });
  }),
);
