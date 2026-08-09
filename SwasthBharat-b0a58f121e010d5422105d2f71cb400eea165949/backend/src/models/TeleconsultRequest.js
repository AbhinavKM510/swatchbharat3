/**
 * Teleconsultation booking.
 *
 * ### This is a SIMULATED feature. Read before demoing.
 *
 * There is no WebRTC, no Twilio, no SIP, no actual call. This model records that a
 * booking was requested and hands back a fake session id so the UI can show a
 * "connecting..." screen and a call layout.
 *
 * Every document is stamped `isSimulated: true` and the API returns that flag, so the
 * limitation travels with the data instead of living only in a slide. If anyone asks
 * during judging, the honest answer is: the booking flow and the queue are real, the
 * call is not.
 *
 * What a real implementation would add: a media server (LiveKit/Janus) or a provider
 * SDK, TURN servers for villages behind carrier NAT, a doctor availability calendar,
 * and consent capture before recording anything.
 */

import mongoose from 'mongoose';

export const TELECONSULT_STATUSES = ['requested', 'connecting', 'in-call', 'completed', 'cancelled'];

const teleconsultSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, unique: true, trim: true },

    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
    assessment: { type: mongoose.Schema.Types.ObjectId, ref: 'Assessment', default: null },

    phc: { type: mongoose.Schema.Types.ObjectId, ref: 'Phc', required: true, index: true },
    district: { type: String, required: true, trim: true },

    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Set when a doctor picks the request up. */
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    reason: { type: String, trim: true, default: '' },
    preferredLanguage: { type: String, enum: ['bn', 'hi', 'en'], default: 'hi' },

    status: { type: String, enum: TELECONSULT_STATUSES, default: 'requested', index: true },

    /** Fake session identifier. Not a real room on any media server. */
    sessionId: { type: String, required: true },

    /** Always true in this build. Kept explicit so the API can never imply otherwise. */
    isSimulated: { type: Boolean, default: true },

    requestedAt: { type: Date, default: () => new Date() },
    completedAt: { type: Date, default: null },
    durationSeconds: { type: Number, default: null },
    notes: { type: String, trim: true, default: '' },
  },
  { timestamps: true },
);

teleconsultSchema.index({ phc: 1, status: 1, requestedAt: -1 });

teleconsultSchema.methods.toPublicJSON = function toPublicJSON() {
  const populatedPatient =
    this.populated('patient') && this.patient && this.patient.name ? this.patient.toPublicJSON() : null;

  return {
    id: this._id.toString(),
    clientId: this.clientId,
    patientId: this.patient ? String(this.patient._id || this.patient) : null,
    patient: populatedPatient,
    assessmentId: this.assessment ? String(this.assessment._id || this.assessment) : null,
    phcId: this.phc ? String(this.phc._id || this.phc) : null,
    district: this.district,
    reason: this.reason,
    preferredLanguage: this.preferredLanguage,
    status: this.status,
    sessionId: this.sessionId,
    isSimulated: this.isSimulated,
    simulationNotice:
      'Demo only: no real call is placed. The booking and queue are real, the video call is simulated.',
    requestedAt: this.requestedAt,
    completedAt: this.completedAt,
    durationSeconds: this.durationSeconds,
    notes: this.notes,
  };
};

export const TeleconsultRequest = mongoose.model('TeleconsultRequest', teleconsultSchema);
