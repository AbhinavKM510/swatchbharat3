/**
 * Device registration for background push notifications.
 *
 * A device registers its FCM token against the AUTHENTICATED user, and that is the only way
 * a token enters the system. The server later decides who receives which alert by querying
 * users by PHC (see services/pushService.js).
 *
 * The alternative — FCM topics, where the client subscribes to `phc-<id>` — is less code and
 * unusable here: the client would be choosing its own audience, so any doctor could
 * subscribe to another PHC's topic and receive that PHC's patient names. There is no
 * endpoint in this file that accepts a PHC, a topic, or a target user, and that absence is
 * the design.
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth, requireRole } from '../middleware/auth.js';
import {
  countPushDevices,
  isPushConfigured,
  pushStatus,
  registerPushToken,
  unregisterPushToken,
} from '../services/pushService.js';
import { ApiError } from '../utils/ApiError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const notificationsRouter = express.Router();

/**
 * Generous but not unbounded. A browser can legitimately re-register on every load (FCM
 * rotates tokens), so this is not a per-session action — but nor should one client be able
 * to churn the token list indefinitely.
 */
const registrationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: { code: 'TOO_MANY_ATTEMPTS', message: 'Too many registration attempts. Try again shortly.' },
  },
});

notificationsRouter.use(requireAuth);

/** Whether the feature is available, and how many devices this user has registered. */
notificationsRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    res.json({
      ...pushStatus(),
      deviceCount: await countPushDevices(req.user._id),
    });
  }),
);

/**
 * Registers this device.
 *
 * Restricted to doctors. They are the only role that receives these alerts (an officer's
 * legitimate view is district rates, not named patients, and a notification body carries a
 * name), so allowing anyone else to register would be storing a credential that is never
 * used — and inviting a future change to start sending PII to the wrong audience.
 */
notificationsRouter.post(
  '/token',
  registrationLimiter,
  requireRole('doctor'),
  asyncHandler(async (req, res) => {
    if (!isPushConfigured()) {
      throw ApiError.notImplemented(
        'PUSH_NOT_CONFIGURED',
        'Background notifications are not enabled on this server.',
      );
    }

    const token = req.body?.token;
    if (!token || typeof token !== 'string') {
      throw ApiError.badRequest('TOKEN_REQUIRED', 'An FCM registration token is required');
    }

    const result = await registerPushToken({
      userId: req.user._id,
      token,
      userAgent: req.get('user-agent') ?? '',
    });

    if (!result.registered) {
      throw ApiError.badRequest('TOKEN_REJECTED', `Token could not be registered: ${result.reason}`);
    }

    res.status(201).json({ registered: true, deviceCount: result.deviceCount });
  }),
);

/**
 * Removes this device.
 *
 * Not restricted by role and deliberately not 404-ing on an unknown token: turning
 * notifications off, or signing out, must always succeed. A user who cannot unsubscribe is
 * a worse problem than one who unsubscribes something already gone.
 */
notificationsRouter.delete(
  '/token',
  asyncHandler(async (req, res) => {
    const token = req.body?.token ?? req.query?.token;
    if (!token || typeof token !== 'string') {
      throw ApiError.badRequest('TOKEN_REQUIRED', 'The FCM registration token is required');
    }

    const result = await unregisterPushToken({ userId: req.user._id, token });
    res.json({ removed: result.removed });
  }),
);
