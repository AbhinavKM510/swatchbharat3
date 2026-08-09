/**
 * Patient records.
 *
 * Patients are normally created implicitly as part of an assessment (the field worker
 * fills one form, not two), so these routes are mostly for lookup: finding a patient a
 * worker screened last month to record a follow-up.
 */

import express from 'express';
import { Assessment } from '../models/Assessment.js';
import { Patient } from '../models/Patient.js';
import { assertCanAccessRecord, requireAuth, scopeFilterFor } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const patientsRouter = express.Router();

patientsRouter.use(requireAuth);

patientsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { search, village, limit = 50, page = 1 } = req.query;

    const filter = { ...scopeFilterFor(req.user) };
    if (village) filter.village = String(village);
    if (search) {
      // Regex rather than $text so partial names work ("sun" finds "Sunita"), which is
      // what a worker actually types. Escaped so a stray "(" cannot break the query.
      const escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped, 'i');
      filter.$or = [{ name: pattern }, { village: pattern }, { phone: pattern }];
    }

    const perPage = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    const currentPage = Math.max(Number.parseInt(page, 10) || 1, 1);

    const [items, total] = await Promise.all([
      Patient.find(filter)
        .sort({ createdAt: -1 })
        .skip((currentPage - 1) * perPage)
        .limit(perPage),
      Patient.countDocuments(filter),
    ]);

    res.json({
      items: items.map((patient) => patient.toPublicJSON()),
      page: currentPage,
      perPage,
      total,
      hasMore: currentPage * perPage < total,
    });
  }),
);

/** One patient plus their screening history, so a doctor can see the trend not a snapshot. */
patientsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const patient = await Patient.findById(req.params.id);
    if (!patient) throw ApiError.notFound('PATIENT_NOT_FOUND', 'No such patient');
    assertCanAccessRecord(req.user, patient);

    const assessments = await Assessment.find({ patient: patient._id })
      .sort({ capturedAt: -1 })
      .limit(20)
      .populate('createdBy', 'name phone');

    res.json({
      patient: patient.toPublicJSON(),
      assessments: assessments.map((assessment) => assessment.toPublicJSON()),
    });
  }),
);
