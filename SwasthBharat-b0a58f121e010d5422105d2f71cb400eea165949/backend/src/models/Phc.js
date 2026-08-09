/**
 * Primary Health Centre.
 *
 * Exists as its own collection because the district-officer view aggregates across
 * PHCs, and because Socket.io rooms are scoped per PHC (a doctor should only receive
 * alerts for their own catchment area, not the whole state).
 */

import mongoose from 'mongoose';

const phcSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    block: { type: String, trim: true, default: '' },
    district: { type: String, required: true, trim: true, index: true },
    state: { type: String, trim: true, default: '' },
    /** Villages this PHC serves. Used to populate the village dropdown in the field form. */
    villages: [{ type: String, trim: true }],
    location: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
    contactPhone: { type: String, trim: true, default: '' },
  },
  { timestamps: true },
);

phcSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: this._id.toString(),
    code: this.code,
    name: this.name,
    block: this.block,
    district: this.district,
    state: this.state,
    villages: this.villages,
    location: this.location,
    contactPhone: this.contactPhone,
  };
};

export const Phc = mongoose.model('Phc', phcSchema);
