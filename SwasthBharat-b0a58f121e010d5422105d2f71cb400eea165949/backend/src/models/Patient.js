/**
 * Patient screened by a field worker.
 *
 * `clientId` is the important field. It is a UUID generated ON THE DEVICE at the moment
 * the record is created, before any network call. Everything else about offline sync
 * hangs off it:
 *
 *   - the device can reference a patient in a queued assessment that the server has
 *     never seen yet
 *   - replaying the same sync batch twice upserts instead of duplicating
 *   - a worker who loses signal mid-visit and retries does not create a second patient
 *
 * Using the server's ObjectId as the only identity would make all three impossible.
 */

import mongoose from 'mongoose';

const patientSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, unique: true, trim: true },

    name: { type: String, required: true, trim: true },
    age: { type: Number, required: true, min: 0, max: 120 },
    sex: { type: String, required: true, enum: ['female', 'male'] },

    /** Optional: many rural patients share a household phone, or have none. */
    phone: { type: String, trim: true, default: '' },

    village: { type: String, trim: true, default: '' },

    phc: { type: mongoose.Schema.Types.ObjectId, ref: 'Phc', required: true, index: true },
    district: { type: String, required: true, trim: true, index: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    /** Device timestamp of first capture; may predate createdAt when synced late. */
    capturedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

patientSchema.index({ phc: 1, createdAt: -1 });
patientSchema.index({ name: 'text', village: 'text' });

patientSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    clientId: this.clientId,
    name: this.name,
    age: this.age,
    sex: this.sex,
    phone: this.phone,
    village: this.village,
    phcId: this.phc ? String(this.phc._id || this.phc) : null,
    district: this.district,
    capturedAt: this.capturedAt,
    createdAt: this.createdAt,
  };
};

export const Patient = mongoose.model('Patient', patientSchema);
