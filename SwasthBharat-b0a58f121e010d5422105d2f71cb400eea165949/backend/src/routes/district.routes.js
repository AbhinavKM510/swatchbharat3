/**
 * District health officer view.
 *
 * An officer oversees many PHCs and needs to spot patterns, not read charts: which
 * centre is flagging an unusual share of high-risk patients, which risk factors dominate
 * locally, whether screening volume is actually rising.
 *
 * Deliberately aggregate-only. An officer gets counts and rates; they do not get
 * individual patient records, because their job does not require identifying anyone.
 */

import express from 'express';
import mongoose from 'mongoose';
import { Assessment } from '../models/Assessment.js';
import { Phc } from '../models/Phc.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const districtRouter = express.Router();

districtRouter.use(requireAuth, requireRole('officer', 'doctor'));

const MAX_WINDOW_DAYS = 365;

districtRouter.get(
  '/trends',
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 30, 1), MAX_WINDOW_DAYS);

    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const match = { district: req.user.district, capturedAt: { $gte: since } };

    const [dailySeries, perPhc, reasonCounts, captureMix, ageBands, totals] = await Promise.all([
      // Daily volume split by band, for the trend line.
      Assessment.aggregate([
        { $match: match },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$capturedAt' } },
              band: '$riskBand',
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.date': 1 } },
      ]),

      // Per-PHC breakdown: the comparison an officer actually acts on.
      Assessment.aggregate([
        { $match: match },
        {
          $group: {
            _id: '$phc',
            total: { $sum: 1 },
            high: { $sum: { $cond: [{ $eq: ['$riskBand', 'HIGH'] }, 1, 0] } },
            moderate: { $sum: { $cond: [{ $eq: ['$riskBand', 'MODERATE'] }, 1, 0] } },
            low: { $sum: { $cond: [{ $eq: ['$riskBand', 'LOW'] }, 1, 0] } },
            openHighRisk: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$riskBand', 'HIGH'] },
                      { $in: ['$reviewStatus', ['pending', 'acknowledged']] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
            avgGlucose: { $avg: '$input.glucoseMgDl' },
            avgBmi: { $avg: '$derived.bmi' },
            lastCapturedAt: { $max: '$capturedAt' },
          },
        },
        { $sort: { high: -1 } },
      ]),

      // Which risk factors dominate in this district. Drives targeted campaigns
      // (e.g. mostly obesity-driven vs mostly glucose-driven).
      Assessment.aggregate([
        { $match: match },
        { $unwind: '$reasons' },
        { $match: { 'reasons.severity': { $in: ['high', 'moderate'] } } },
        { $group: { _id: '$reasons.code', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),

      // Adoption signal: is voice entry actually being used, and how much of the data
      // arrives from offline capture (i.e. how bad is connectivity in practice).
      Assessment.aggregate([
        { $match: match },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            voice: { $sum: { $cond: [{ $in: ['$inputMethod', ['voice', 'mixed']] }, 1, 0] } },
            offline: { $sum: { $cond: [{ $eq: ['$source', 'offline-sync'] }, 1, 0] } },
            bengali: { $sum: { $cond: [{ $eq: ['$language', 'bn'] }, 1, 0] } },
            hindi: { $sum: { $cond: [{ $eq: ['$language', 'hi'] }, 1, 0] } },
          },
        },
      ]),

      // High-risk share by age band, to show where screening effort should concentrate.
      Assessment.aggregate([
        { $match: match },
        {
          $bucket: {
            groupBy: '$input.age',
            boundaries: [0, 30, 40, 50, 60, 121],
            default: 'unknown',
            output: {
              total: { $sum: 1 },
              high: { $sum: { $cond: [{ $eq: ['$riskBand', 'HIGH'] }, 1, 0] } },
            },
          },
        },
      ]),

      Assessment.aggregate([
        { $match: { district: req.user.district } },
        { $group: { _id: '$riskBand', count: { $sum: 1 } } },
      ]),
    ]);

    // Resolve PHC names for the breakdown.
    const phcIds = perPhc.map((row) => row._id).filter((id) => id instanceof mongoose.Types.ObjectId);
    const phcs = await Phc.find({ _id: { $in: phcIds } });
    const phcById = new Map(phcs.map((phc) => [phc._id.toString(), phc]));

    // Fill gaps so the chart has a point for every day, including zero-volume days.
    const seriesByDate = new Map();
    for (const row of dailySeries) {
      const entry = seriesByDate.get(row._id.date) || { date: row._id.date, LOW: 0, MODERATE: 0, HIGH: 0 };
      entry[row._id.band] = row.count;
      seriesByDate.set(row._id.date, entry);
    }

    const filledSeries = [];
    for (let offset = 0; offset < days; offset += 1) {
      const day = new Date(since);
      day.setDate(day.getDate() + offset);
      const key = day.toISOString().slice(0, 10);
      const entry = seriesByDate.get(key) || { date: key, LOW: 0, MODERATE: 0, HIGH: 0 };
      filledSeries.push({ ...entry, total: entry.LOW + entry.MODERATE + entry.HIGH });
    }

    const allTime = { LOW: 0, MODERATE: 0, HIGH: 0 };
    for (const row of totals) {
      if (row._id in allTime) allTime[row._id] = row.count;
    }

    const mix = captureMix[0] || { total: 0, voice: 0, offline: 0, bengali: 0, hindi: 0 };
    const share = (value) => (mix.total > 0 ? Number((value / mix.total).toFixed(4)) : 0);

    const ageBandLabels = { 0: 'under30', 30: '30-39', 40: '40-49', 50: '50-59', 60: '60plus' };

    res.json({
      district: req.user.district,
      window: { days, since: since.toISOString() },

      allTimeByBand: allTime,

      dailySeries: filledSeries,

      perPhc: perPhc.map((row) => {
        const phc = phcById.get(String(row._id));
        return {
          phcId: String(row._id),
          code: phc?.code ?? 'UNKNOWN',
          name: phc?.name ?? 'Unknown PHC',
          block: phc?.block ?? '',
          total: row.total,
          high: row.high,
          moderate: row.moderate,
          low: row.low,
          openHighRisk: row.openHighRisk,
          highRiskRate: row.total > 0 ? Number((row.high / row.total).toFixed(4)) : 0,
          avgGlucose: row.avgGlucose ? Number(row.avgGlucose.toFixed(1)) : null,
          avgBmi: row.avgBmi ? Number(row.avgBmi.toFixed(1)) : null,
          lastCapturedAt: row.lastCapturedAt,
        };
      }),

      topRiskFactors: reasonCounts.map((row) => ({ code: row._id, count: row.count })),

      byAgeBand: ageBands.map((row) => ({
        band: ageBandLabels[row._id] ?? String(row._id),
        total: row.total,
        high: row.high,
        highRiskRate: row.total > 0 ? Number((row.high / row.total).toFixed(4)) : 0,
      })),

      adoption: {
        assessments: mix.total,
        voiceEntryShare: share(mix.voice),
        offlineCaptureShare: share(mix.offline),
        languageShare: { bn: share(mix.bengali), hi: share(mix.hindi), en: share(mix.total - mix.bengali - mix.hindi) },
      },

      generatedAt: new Date().toISOString(),
    });
  }),
);

/** PHC directory for the district, used to populate filters and the field-worker form. */
districtRouter.get(
  '/phcs',
  asyncHandler(async (req, res) => {
    const phcs = await Phc.find({ district: req.user.district }).sort({ name: 1 });
    res.json({ items: phcs.map((phc) => phc.toPublicJSON()) });
  }),
);
