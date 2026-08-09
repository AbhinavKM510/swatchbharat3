/**
 * PHC doctor dashboard.
 *
 * The dashboard is a worklist, not a report. Its job is to answer one question fast:
 * "who in my catchment area needs to be seen, and who has not been dealt with yet?"
 *
 * The live-updating part comes over Socket.io (see realtime/io.js). These endpoints
 * provide the initial state and the counts.
 */

import express from 'express';
import { Assessment } from '../models/Assessment.js';
import { Patient } from '../models/Patient.js';
import { requireAuth, requireRole, scopeFilterFor } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { realtimeStats } from '../realtime/io.js';

export const dashboardRouter = express.Router();

dashboardRouter.use(requireAuth, requireRole('doctor', 'officer', 'asha'));

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * The flagged-cases queue.
 *
 * Ordered by risk first and then oldest-first inside each band. Oldest-first is
 * deliberate: a high-risk patient screened three days ago and never contacted is a worse
 * problem than one screened an hour ago, and a newest-first list buries exactly the
 * people who have been waiting longest.
 */
dashboardRouter.get(
  '/flagged',
  asyncHandler(async (req, res) => {
    const { band = 'HIGH', status = 'open', limit = 50 } = req.query;

    const filter = { ...scopeFilterFor(req.user) };

    const bands = String(band)
      .split(',')
      .map((b) => b.trim().toUpperCase())
      .filter((b) => ['LOW', 'MODERATE', 'HIGH'].includes(b));
    if (bands.length > 0) filter.riskBand = { $in: bands };

    if (status === 'open') filter.reviewStatus = { $in: ['pending', 'acknowledged'] };
    else if (status !== 'all') filter.reviewStatus = String(status);

    const perPage = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);

    const items = await Assessment.find(filter)
      .sort({ riskBand: -1, capturedAt: 1 })
      .limit(perPage)
      .populate('patient')
      .populate('createdBy', 'name phone');

    res.json({
      items: items.map((item) => item.toPublicJSON()),
      count: items.length,
      /** Echoed so the UI can label the list honestly ("open high-risk cases"). */
      query: { bands, status },
    });
  }),
);

/** Headline counts for the dashboard cards. */
dashboardRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const scope = scopeFilterFor(req.user);
    const today = startOfToday();
    const weekStart = daysAgo(7);

    const [
      bandCounts,
      todayCount,
      weekCount,
      openHighRisk,
      mismatches,
      disagreements,
      offlineSynced,
      patients,
      live,
    ] = await Promise.all([
        Assessment.aggregate([
          { $match: scope },
          { $group: { _id: '$riskBand', count: { $sum: 1 } } },
        ]),
        Assessment.countDocuments({ ...scope, capturedAt: { $gte: today } }),
        Assessment.countDocuments({ ...scope, capturedAt: { $gte: weekStart } }),
        Assessment.countDocuments({
          ...scope,
          riskBand: 'HIGH',
          reviewStatus: { $in: ['pending', 'acknowledged'] },
        }),
        Assessment.countDocuments({ ...scope, bandMismatch: true }),
        Assessment.countDocuments({ ...scope, modelDisagreement: true }),
        Assessment.countDocuments({ ...scope, source: 'offline-sync' }),
        Patient.countDocuments(scope),
        realtimeStats(),
      ]);

    const byBand = { LOW: 0, MODERATE: 0, HIGH: 0 };
    for (const row of bandCounts) {
      if (row._id in byBand) byBand[row._id] = row.count;
    }
    const total = byBand.LOW + byBand.MODERATE + byBand.HIGH;

    res.json({
      totals: {
        assessments: total,
        patients,
        today: todayCount,
        last7Days: weekCount,
      },
      byBand,
      highRiskRate: total > 0 ? Number((byBand.HIGH / total).toFixed(4)) : 0,
      queue: { openHighRisk },
      dataQuality: {
        /**
         * Records where the device's offline score disagreed with the server's re-score.
         * Non-zero means at least one device is running a stale model bundle.
         */
        bandMismatches: mismatches,
        /**
         * Records where the decision tree and the neural second opinion landed in
         * different bands. Unlike bandMismatches this is NOT a fault indicator — it is a
         * shortlist. Those patients sit near a decision boundary, which is a reason for a
         * doctor to look at them sooner rather than a sign anything is broken.
         */
        modelDisagreements: disagreements,
        modelDisagreementShare: total > 0 ? Number((disagreements / total).toFixed(4)) : 0,
        /** How many records arrived from offline capture rather than a live connection. */
        syncedFromOffline: offlineSynced,
        offlineShare: total > 0 ? Number((offlineSynced / total).toFixed(4)) : 0,
      },
      realtime: live,
      scope: {
        role: req.user.role,
        phcId: req.user.phc ? String(req.user.phc._id || req.user.phc) : null,
        district: req.user.district,
      },
      generatedAt: new Date().toISOString(),
    });
  }),
);
