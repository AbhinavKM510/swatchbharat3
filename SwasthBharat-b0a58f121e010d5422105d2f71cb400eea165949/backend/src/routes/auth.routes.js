/**
 * Authentication: register, login, session lookup, language preference.
 *
 * ### Why registration is restricted
 *
 * Self-registration can only ever create an `asha` (field worker) account, which sees
 * only its own submissions. Creating a `doctor` account (reads every patient in a PHC) or
 * an `officer` account (reads a whole district) additionally requires the `SETUP_TOKEN`
 * from the server environment.
 *
 * Without that split, anyone who could reach the API could register as a doctor and read
 * every patient record in the district. For the demo, use `npm run seed` to create the
 * doctor and officer logins.
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config/env.js';
import { isFirebaseConfigured, verifyFirebaseIdToken } from '../config/firebase.js';
import { Phc } from '../models/Phc.js';
import { USER_ROLES, User } from '../models/User.js';
import { issueToken, requireAuth } from '../middleware/auth.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const authRouter = express.Router();

/**
 * Brute-force protection on credential endpoints. Generous enough that a worker
 * mistyping a password on a cracked screen is not locked out mid-visit.
 */
const credentialLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: {
      code: 'TOO_MANY_ATTEMPTS',
      message: 'Too many attempts. Please wait a few minutes and try again.',
    },
  },
});

const MIN_PASSWORD_LENGTH = 8;

/**
 * The PHC list the sign-up form needs, without a login.
 *
 * Unauthenticated by necessity: someone creating their first account has no token, and
 * asking them to type an exact code like "NAD-PHC-01" from memory is how you get accounts
 * filed against the wrong health centre — which then routes a high-risk alert to doctors
 * who cannot act on it.
 *
 * ### Why this is a hand-written projection and not `toPublicJSON()`
 *
 * `Phc.toPublicJSON()` also carries `villages`, `location` and `contactPhone`. None of that
 * is secret, but none of it is needed to pick an item from a dropdown either, and this is
 * the one PHC route with no authentication in front of it. Listing the three fields
 * explicitly means a field added to the model later — a staff roster, an in-charge's
 * personal number — does not silently become public because this endpoint returned
 * whatever the model happened to hold.
 *
 * Deliberately NOT rate-limited by `credentialLimiter`: it shares a counter with login, and
 * a form that fetches this on mount would spend a worker's login budget before they had
 * typed anything.
 */
authRouter.get(
  '/phcs',
  asyncHandler(async (_req, res) => {
    const phcs = await Phc.find({}).sort({ name: 1 }).select('code name block district');
    res.json({
      items: phcs.map((phc) => ({
        code: phc.code,
        name: phc.name,
        block: phc.block,
        district: phc.district,
      })),
    });
  }),
);

function normalisePhone(value) {
  // Accepts "+91 98765 43210", "098765-43210" etc. and reduces to the 10 national digits.
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

authRouter.post(
  '/register',
  credentialLimiter,
  asyncHandler(async (req, res) => {
    const { name, password, role = 'asha', language = 'hi', phcCode, villages = [] } = req.body || {};
    const phone = normalisePhone(req.body?.phone);

    if (!name || !String(name).trim()) {
      throw ApiError.badRequest('NAME_REQUIRED', 'Name is required');
    }
    if (!/^[6-9]\d{9}$/.test(phone)) {
      throw ApiError.badRequest('PHONE_INVALID', 'Enter a valid 10-digit Indian mobile number');
    }
    if (!password || String(password).length < MIN_PASSWORD_LENGTH) {
      throw ApiError.badRequest(
        'PASSWORD_TOO_SHORT',
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
    }
    if (!USER_ROLES.includes(role)) {
      throw ApiError.badRequest('ROLE_INVALID', `Role must be one of: ${USER_ROLES.join(', ')}`);
    }

    // The privilege gate.
    if (role !== 'asha') {
      const provided = req.get('x-setup-token') || req.body?.setupToken || '';
      if (!config.setupToken || provided !== config.setupToken) {
        throw ApiError.forbidden(
          'SETUP_TOKEN_REQUIRED',
          'Creating a doctor or district-officer account requires a valid setup token',
        );
      }
    }

    if (!phcCode) {
      throw ApiError.badRequest('PHC_REQUIRED', 'A PHC code is required so records can be filed correctly');
    }

    const phc = await Phc.findOne({ code: String(phcCode).toUpperCase().trim() });
    if (!phc) {
      throw ApiError.badRequest('PHC_NOT_FOUND', `No PHC found with code "${phcCode}"`);
    }

    if (await User.exists({ phone })) {
      throw ApiError.conflict('PHONE_IN_USE', 'An account already exists for this mobile number');
    }

    const user = await User.create({
      name: String(name).trim(),
      phone,
      passwordHash: await User.hashPassword(String(password)),
      role,
      language: ['bn', 'hi', 'en'].includes(language) ? language : 'hi',
      phc: phc._id,
      district: phc.district,
      villages: Array.isArray(villages) ? villages.map((v) => String(v).trim()).filter(Boolean) : [],
    });

    await user.populate('phc');

    res.status(201).json({ token: issueToken(user), user: user.toPublicJSON() });
  }),
);

authRouter.post(
  '/login',
  credentialLimiter,
  asyncHandler(async (req, res) => {
    const phone = normalisePhone(req.body?.phone);
    const password = req.body?.password;

    if (!phone || !password) {
      throw ApiError.badRequest('CREDENTIALS_REQUIRED', 'Mobile number and password are required');
    }

    // Same error for "no such user" and "wrong password" so the endpoint cannot be used
    // to enumerate which phone numbers have accounts.
    const user = await User.findOne({ phone }).select('+passwordHash').populate('phc');
    if (!user || !(await user.verifyPassword(String(password)))) {
      throw ApiError.unauthorized('INVALID_CREDENTIALS', 'Mobile number or password is incorrect');
    }
    if (!user.isActive) {
      throw ApiError.forbidden('ACCOUNT_DISABLED', 'This account has been disabled');
    }

    user.lastLoginAt = new Date();
    await user.save();

    res.json({ token: issueToken(user), user: user.toPublicJSON() });
  }),
);

/**
 * Exchanges a Firebase phone-OTP ID token for this application's own JWT.
 *
 * WHY AN EXCHANGE RATHER THAN USING THE FIREBASE TOKEN DIRECTLY
 * -------------------------------------------------------------
 * Every protected route, and the Socket.io handshake, reads `role`, `phcId` and `district`
 * out of the app's JWT. Accepting Firebase ID tokens throughout would mean either putting
 * those claims into Firebase custom claims — moving the cross-PHC isolation guarantee into
 * a third-party token and a web console, where this repository cannot review it and
 * `check-security.mjs` cannot test it — or a Mongo lookup plus a remote token verification
 * on every single request.
 *
 * Exchanging once at login keeps Firebase at the edge, doing the one thing it is good at:
 * proving control of a phone number. Authorisation stays here, in code that can be read.
 *
 * WHAT THIS ROUTE WILL NOT DO
 * ---------------------------
 * It will not create an account unless FIREBASE_ALLOW_SIGNUP is explicitly enabled, and
 * even then only an `asha` one. A verified phone number proves someone owns a SIM. It does
 * not prove they are a health worker, and it must never be able to produce a doctor or
 * officer account — those read every patient in a PHC or a district respectively, and are
 * gated behind SETUP_TOKEN for exactly that reason.
 *
 * It also will not accept a token whose phone number is missing or does not normalise to a
 * valid Indian mobile number, because `phone` is this system's user identity.
 */
authRouter.post(
  '/firebase',
  credentialLimiter,
  asyncHandler(async (req, res) => {
    if (!isFirebaseConfigured()) {
      throw ApiError.notImplemented(
        'FIREBASE_NOT_CONFIGURED',
        'Phone sign-in is not enabled on this server. Use mobile number and password.',
      );
    }

    const idToken = req.body?.idToken;
    if (!idToken || typeof idToken !== 'string') {
      throw ApiError.badRequest('ID_TOKEN_REQUIRED', 'A Firebase ID token is required');
    }

    let decoded;
    try {
      decoded = await verifyFirebaseIdToken(idToken);
    } catch (error) {
      // Deliberately does not echo Firebase's message: it distinguishes expired from
      // malformed from revoked, which is more than a caller needs and more than is wise
      // to hand an attacker. The real reason is logged for whoever is debugging.
      console.warn(`[auth] Firebase ID token rejected: ${error?.code || error?.message}`);
      throw ApiError.unauthorized('FIREBASE_TOKEN_INVALID', 'Phone sign-in could not be verified');
    }

    if (!decoded) {
      throw ApiError.notImplemented(
        'FIREBASE_NOT_CONFIGURED',
        'Phone sign-in is not enabled on this server. Use mobile number and password.',
      );
    }

    // Only phone sign-in. An email or anonymous Firebase token must not become a session
    // here, because this system keys users by phone number.
    const phone = normalisePhone(decoded.phone_number);
    if (!/^[6-9]\d{9}$/.test(phone)) {
      throw ApiError.badRequest(
        'PHONE_INVALID',
        'Phone sign-in requires a verified 10-digit Indian mobile number',
      );
    }

    let user = await User.findOne({ phone }).populate('phc');

    if (!user) {
      if (!config.firebaseAllowSignUp) {
        throw ApiError.forbidden(
          'ACCOUNT_NOT_PROVISIONED',
          'No account exists for this mobile number. Ask your PHC supervisor to create one.',
        );
      }

      // Self-provisioning path, off by default. Field worker only, never a clinical role.
      const phc = await Phc.findOne({ code: String(req.body?.phcCode || '').toUpperCase().trim() });
      if (!phc) {
        throw ApiError.badRequest(
          'PHC_REQUIRED',
          'A valid PHC code is required to create an account',
        );
      }

      user = await User.create({
        name: String(req.body?.name || '').trim() || `Worker ${phone.slice(-4)}`,
        phone,
        firebaseUid: decoded.uid,
        role: 'asha',
        language: ['bn', 'hi', 'en'].includes(req.body?.language) ? req.body.language : 'hi',
        phc: phc._id,
        district: phc.district,
      });
      await user.populate('phc');
    }

    if (!user.isActive) {
      throw ApiError.forbidden('ACCOUNT_DISABLED', 'This account has been disabled');
    }

    /**
     * Bind the Firebase uid to the account on first use, and refuse if a DIFFERENT uid is
     * already bound.
     *
     * That refusal is the important half. Firebase reuses a phone number's uid, so a
     * mismatch is not routine — it means the number was recycled to a new Firebase user,
     * or two projects are pointed at one database. Either way, silently rebinding would
     * hand an existing health worker's patient records to whoever now holds that SIM.
     * Re-linking is a deliberate administrative act, not something a login should do.
     */
    if (!user.firebaseUid) {
      user.firebaseUid = decoded.uid;
    } else if (user.firebaseUid !== decoded.uid) {
      console.warn(
        `[auth] Firebase uid mismatch for ${phone}: bound ${user.firebaseUid}, presented ${decoded.uid}`,
      );
      throw ApiError.forbidden(
        'FIREBASE_UID_MISMATCH',
        'This mobile number is linked to a different sign-in. Contact your supervisor.',
      );
    }

    user.lastLoginAt = new Date();
    await user.save();

    res.json({
      token: issueToken(user),
      user: user.toPublicJSON(),
      /** So the client can tell an OTP session from a password one without decoding a JWT. */
      signInMethod: 'phone-otp',
    });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: req.user.toPublicJSON() });
  }),
);

/**
 * Persists the UI language server-side so a worker who logs in on a replacement phone
 * gets their own language immediately, without hunting through a settings menu.
 */
authRouter.patch(
  '/me/language',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { language } = req.body || {};
    if (!['bn', 'hi', 'en'].includes(language)) {
      throw ApiError.badRequest('LANGUAGE_INVALID', 'Language must be one of: bn, hi, en');
    }
    req.user.language = language;
    await req.user.save();
    res.json({ user: req.user.toPublicJSON() });
  }),
);
