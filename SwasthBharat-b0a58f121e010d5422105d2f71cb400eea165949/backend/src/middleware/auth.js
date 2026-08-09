/**
 * JWT authentication and role authorisation.
 *
 * Access model (deliberately narrow — this is patient health data):
 *
 *   asha    -> only records they created, only in their own PHC
 *   doctor  -> every record in their own PHC
 *   officer -> aggregates for their own district; no individual patient records
 *
 * The scoping is applied as a Mongo filter built here (`scopeFilterFor`), not left to
 * each route to remember. A route that forgets to scope is a data leak, so the default
 * has to be safe.
 */

import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * @param {import('../models/User.js').User} user
 * @returns {string} signed JWT
 */
export function issueToken(user) {
  return jwt.sign(
    {
      sub: user._id.toString(),
      role: user.role,
      phcId: user.phc ? String(user.phc._id || user.phc) : null,
      district: user.district,
    },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );
}

/** Verifies a raw token string. Shared with the Socket.io handshake. */
export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw ApiError.unauthorized('TOKEN_EXPIRED', 'Session expired, please log in again');
    }
    throw ApiError.unauthorized('TOKEN_INVALID', 'Invalid authentication token');
  }
}

function extractToken(req) {
  const header = req.get('authorization') || '';
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();
  return null;
}

/**
 * Requires a valid token AND an active user record.
 *
 * Re-loading the user on every request costs one indexed lookup and buys the ability to
 * deactivate an account immediately, rather than waiting out the token's lifetime.
 */
export const requireAuth = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) {
    throw ApiError.unauthorized('NO_TOKEN', 'Authorization header with a Bearer token is required');
  }

  const payload = verifyToken(token);
  const user = await User.findById(payload.sub).populate('phc');

  if (!user) throw ApiError.unauthorized('USER_NOT_FOUND', 'Account no longer exists');
  if (!user.isActive) throw ApiError.forbidden('ACCOUNT_DISABLED', 'This account has been disabled');

  req.user = user;
  req.tokenPayload = payload;
  next();
});

/**
 * Restricts a route to specific roles.
 * @param {...('asha'|'doctor'|'officer')} roles
 */
export function requireRole(...roles) {
  return function roleGuard(req, _res, next) {
    if (!req.user) {
      next(ApiError.unauthorized('NO_TOKEN', 'Authentication required'));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(
        ApiError.forbidden(
          'ROLE_NOT_PERMITTED',
          `This action requires one of: ${roles.join(', ')}. Your role is ${req.user.role}.`,
        ),
      );
      return;
    }
    next();
  };
}

/**
 * Builds the Mongo filter that limits a query to what this user is allowed to see.
 *
 * @param {object} user
 * @returns {object} filter fragment to spread into a query
 */
export function scopeFilterFor(user) {
  switch (user.role) {
    case 'doctor':
      // Whole PHC, but nothing outside it.
      return { phc: user.phc?._id ?? user.phc };
    case 'officer':
      return { district: user.district };
    case 'asha':
    default:
      return { createdBy: user._id };
  }
}

/**
 * Throws unless the user may read this specific document.
 * Used on single-record fetches, where a filter alone is not enough.
 */
export function assertCanAccessRecord(user, doc) {
  const docPhc = doc.phc ? String(doc.phc._id || doc.phc) : null;
  const userPhc = user.phc ? String(user.phc._id || user.phc) : null;

  if (user.role === 'doctor' && docPhc === userPhc) return;
  if (user.role === 'officer' && doc.district === user.district) return;
  if (user.role === 'asha' && String(doc.createdBy._id || doc.createdBy) === user._id.toString()) return;

  throw ApiError.forbidden('OUT_OF_SCOPE', 'This record is outside your assigned area');
}
