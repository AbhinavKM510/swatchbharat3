/**
 * Platform user: ASHA/ANM field worker, PHC doctor, or district health officer.
 *
 * Login is by phone number, not email — the intended field users have a phone and
 * frequently no email address at all.
 */

import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { config } from '../config/env.js';

export const USER_ROLES = ['asha', 'doctor', 'officer'];

/** Roles that may read patient data beyond their own submissions. */
export const CLINICAL_ROLES = ['doctor', 'officer'];

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    /** 10-digit Indian mobile number, stored without country code. */
    phone: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      match: [/^[6-9]\d{9}$/, 'Phone must be a 10-digit Indian mobile number'],
    },

    /**
     * Not required, because an account created for phone-OTP sign-in has no password.
     * `verifyPassword` treats a missing hash as "this account cannot log in with a
     * password" rather than throwing, so the login route still answers with the same
     * INVALID_CREDENTIALS as an unknown number and remains non-enumerable.
     */
    passwordHash: { type: String, default: null, select: false },

    /**
     * Firebase Auth uid, set the first time this user signs in with phone OTP.
     *
     * The uid is a LINK, not an identity. Role, PHC and district all continue to come from
     * this document, so Firebase cannot grant anyone access to a PHC.
     *
     * NO `default: null`, and a PARTIAL index rather than a sparse one. Both matter, and
     * getting it wrong breaks seeding outright:
     *
     *   - A sparse unique index only skips documents where the field is ABSENT. An explicit
     *     stored `null` is a value like any other, so with `default: null` the first
     *     password-only user inserts fine and the second fails with E11000 on
     *     `{ firebaseUid: null }`. That is not a hypothetical — it took down `runSeed()`.
     *   - `partialFilterExpression: { firebaseUid: { $type: 'string' } }` indexes only
     *     documents where the field actually holds a string, so it is correct whether the
     *     field is absent, null, or later given a default back by someone tidying up.
     */
    firebaseUid: {
      type: String,
      index: {
        unique: true,
        partialFilterExpression: { firebaseUid: { $type: 'string' } },
      },
    },

    role: { type: String, required: true, enum: USER_ROLES, default: 'asha', index: true },

    /** Preferred UI language, so a worker's device comes up in their language after login. */
    language: { type: String, enum: ['bn', 'hi', 'en'], default: 'hi' },

    /** Field workers and doctors belong to one PHC. Officers cover a whole district. */
    phc: { type: mongoose.Schema.Types.ObjectId, ref: 'Phc', default: null, index: true },

    district: { type: String, required: true, trim: true, index: true },

    /** ASHA workers cover specific villages. */
    villages: [{ type: String, trim: true }],

    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date, default: null },

    /**
     * Firebase Cloud Messaging device tokens, for alerts when the dashboard is closed.
     *
     * `select: false`. These are bearer-ish credentials — anyone holding a token can push a
     * notification to that device through the project — and no API response has a reason to
     * include them. Excluding them by default means a future route cannot leak the list by
     * forgetting to strip it; the two places that legitimately need them ask explicitly.
     *
     * Stored on the user rather than in a separate collection because they are only ever
     * read as "this user's devices" or "the devices of every doctor at this PHC", both of
     * which this shape answers in one query.
     */
    pushTokens: {
      type: [
        {
          token: { type: String, required: true },
          /** Truncated on write. Only for a recognisable "your devices" list. */
          userAgent: { type: String, default: '' },
          createdAt: { type: Date, default: () => new Date() },
          /** Refreshed on re-registration; drives oldest-first eviction at the cap. */
          lastSeenAt: { type: Date, default: () => new Date() },
          _id: false,
        },
      ],
      default: [],
      select: false,
    },
  },
  { timestamps: true },
);

/**
 * Finding which user owns a device token, for the "release it from its previous owner"
 * step when a shared handset changes hands.
 */
userSchema.index({ 'pushTokens.token': 1 });

userSchema.statics.hashPassword = async function hashPassword(plain) {
  return bcrypt.hash(plain, config.bcryptRounds);
};

/**
 * Compares a plaintext password against the stored hash.
 *
 * Returns false — rather than throwing — for an account with no password at all, which is
 * now a legitimate state for an OTP-only user. The login route turns that into the same
 * INVALID_CREDENTIALS as an unknown phone number, so the endpoint still cannot be used to
 * discover which numbers exist or which sign-in method they use.
 *
 * Still throws when the field was simply not selected, because that is a caller bug: the
 * query needs `.select('+passwordHash')`, and silently returning false would turn a
 * missing projection into "wrong password" and cost somebody an afternoon.
 */
userSchema.methods.verifyPassword = async function verifyPassword(plain) {
  if (this.passwordHash === undefined) {
    throw new Error('verifyPassword called on a user loaded without passwordHash');
  }
  if (this.passwordHash === null) return false;
  return bcrypt.compare(plain, this.passwordHash);
};

/** True when this account can sign in with a password at all. */
userSchema.methods.hasPassword = function hasPassword() {
  return Boolean(this.passwordHash);
};

/** Never returns passwordHash. Used for every user payload the API sends out. */
userSchema.methods.toPublicJSON = function toPublicJSON() {
  const phc = this.populated('phc') && this.phc ? this.phc : null;
  return {
    id: this._id.toString(),
    name: this.name,
    phone: this.phone,
    role: this.role,
    language: this.language,
    district: this.district,
    villages: this.villages,
    phcId: this.phc ? String(this.phc._id || this.phc) : null,
    phc: phc ? phc.toPublicJSON() : null,
    isActive: this.isActive,
    lastLoginAt: this.lastLoginAt,
    /**
     * True when this account can sign in with phone OTP.
     *
     * Only this flag, not the Firebase uid: the uid is an internal link, no client has a
     * use for it, and putting a third-party identifier in every user payload is a leak
     * waiting to happen.
     *
     * There is deliberately no matching `hasPassword` flag. `passwordHash` is
     * `select: false`, so it is absent from most queries, and a flag derived from it would
     * silently read `false` for password accounts everywhere except the login route.
     * A field that is right in one code path and wrong in the rest is worse than no field.
     */
    phoneOtpLinked: Boolean(this.firebaseUid),
  };
};

export const User = mongoose.model('User', userSchema);
