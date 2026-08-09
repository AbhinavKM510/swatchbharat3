/**
 * Background push notifications via Firebase Cloud Messaging.
 *
 * WHAT THIS IS FOR
 * ----------------
 * Socket.io already delivers high-risk cases to an OPEN dashboard, instantly. That is the
 * live demo moment and nothing here replaces it. But a PHC doctor is not sitting in front
 * of the dashboard — `prompts/03` says so directly — and a Socket.io event reaches nobody
 * when the tab is closed. The project's stated fallback for that was SMS, which is listed
 * as unbuilt because it needs a licensed, DLT-registered Indian sender.
 *
 * Web push is the buildable version of that gap. Socket.io for live, FCM for closed.
 *
 * THE SECURITY RULE THAT SHAPES THIS ENTIRE FILE
 * ---------------------------------------------
 * FCM offers topics: a client subscribes to `phc-<id>` and the server publishes to it. That
 * is far less code than what is below, and it is not usable here, because subscription
 * would happen ON THE CLIENT. Any authenticated doctor could subscribe to another PHC's
 * topic and receive that PHC's patient names. The topic string would BE the authorisation
 * check — and `check-security.mjs` asserts that a Chakdaha doctor gets 403 OUT_OF_SCOPE on
 * a Haringhata record, an invariant a client-chosen topic would quietly route around.
 *
 * So: devices register a token against their own authenticated account, and the server
 * decides who receives what by querying `User` for the PHC in question. The recipient list
 * is derived from the database on every send, never from anything a client asserts.
 *
 * OPTIONAL, AND NEVER LOAD-BEARING
 * --------------------------------
 * Every function degrades to a no-op when Firebase is not configured, and every send is
 * wrapped so a messaging failure cannot fail the screening that triggered it. A worker
 * submitting a patient must never see an error because a doctor's phone could not be
 * reached.
 */

import { config } from '../config/env.js';
import { getFirebaseApp, isFirebaseConfigured } from '../config/firebase.js';
import { User } from '../models/User.js';

/**
 * Tokens FCM tells us are permanently invalid. These are pruned from the database rather
 * than retried: an uninstalled PWA or a cleared browser leaves a token that will never work
 * again, and keeping it means every future send does wasted work and reports a false
 * failure.
 */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/** Cap per send. FCM's own limit for sendEachForMulticast is 500. */
const MAX_TOKENS_PER_SEND = 500;

export function isPushConfigured() {
  return isFirebaseConfigured() && config.pushEnabled;
}

/**
 * Registers a device token against a user.
 *
 * Two things worth noting:
 *
 * 1. The same token is first REMOVED from every other user. A field handset is shared —
 *    one worker signs out, the next signs in — and FCM issues the token per browser
 *    installation, not per account. Without this, the previous worker's notifications keep
 *    arriving on a device now held by someone else, which on this dataset means patient
 *    names going to the wrong person.
 *
 * 2. Tokens are capped per user, oldest evicted first. A doctor using several browsers
 *    accumulates tokens indefinitely otherwise, and most of them are stale.
 *
 * Takes a userId and loads its own document with `+pushTokens`, rather than accepting the
 * one `requireAuth` attached. `pushTokens` is `select: false`, so the request's user object
 * does not have the field — and mutating an absent array is a TypeError at runtime, not a
 * build error. Fetching here makes the function correct regardless of how a caller happens
 * to have loaded the user.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {string} args.token  FCM registration token
 * @param {string} [args.userAgent] for the "your devices" list; truncated
 */
export async function registerPushToken({ userId, token, userAgent = '' }) {
  const trimmed = String(token || '').trim();
  if (!trimmed) return { registered: false, reason: 'EMPTY_TOKEN' };

  const user = await User.findById(userId).select('+pushTokens');
  if (!user) return { registered: false, reason: 'USER_NOT_FOUND' };

  // Claim the token for this user, releasing it from anyone else who had it.
  await User.updateMany(
    { _id: { $ne: user._id }, 'pushTokens.token': trimmed },
    { $pull: { pushTokens: { token: trimmed } } },
  );

  const existing = (user.pushTokens ?? []).find((entry) => entry.token === trimmed);
  if (existing) {
    existing.lastSeenAt = new Date();
    existing.userAgent = String(userAgent).slice(0, 200);
  } else {
    user.pushTokens.push({
      token: trimmed,
      userAgent: String(userAgent).slice(0, 200),
      createdAt: new Date(),
      lastSeenAt: new Date(),
    });
  }

  // Oldest-first eviction, so the device someone is actually holding survives.
  if (user.pushTokens.length > config.pushMaxTokensPerUser) {
    user.pushTokens.sort((a, b) => new Date(a.lastSeenAt) - new Date(b.lastSeenAt));
    user.pushTokens = user.pushTokens.slice(-config.pushMaxTokensPerUser);
  }

  await user.save();
  return { registered: true, deviceCount: user.pushTokens.length };
}

/**
 * Removes one token, e.g. on sign-out or when the user turns notifications off.
 *
 * Uses an atomic `$pull` rather than load-filter-save. There is no read-modify-write race
 * to lose, and it does not need `+pushTokens` on a document it is not otherwise reading.
 */
export async function unregisterPushToken({ userId, token }) {
  const trimmed = String(token || '').trim();
  if (!trimmed) return { removed: false };

  const result = await User.updateOne(
    { _id: userId },
    { $pull: { pushTokens: { token: trimmed } } },
  );

  return { removed: result.modifiedCount > 0 };
}

/** How many devices this user has registered. Used by the settings toggle. */
export async function countPushDevices(userId) {
  const user = await User.findById(userId).select('+pushTokens').lean();
  return user?.pushTokens?.length ?? 0;
}

/**
 * Collects the tokens that should receive an alert for one PHC.
 *
 * THIS IS THE AUTHORISATION BOUNDARY. The recipient set is computed here, from the
 * database, by matching `phc` and a clinical role — never from a client-supplied topic or
 * id. Note that district officers are deliberately EXCLUDED even though they may read the
 * district's aggregate data: a push notification carries a patient's name in its body, and
 * an officer's legitimate view is rates, not people. Sending them these would leak PII
 * across a privacy boundary the API otherwise enforces.
 *
 * The user's `language` comes back too, so sends can be grouped by it. A service worker has
 * no access to the app's stored language preference, so the alternative would be either an
 * English-only notification or a cookie written solely for the worker to read back. The
 * account already records a language; using it is both simpler and correct for a doctor
 * with two devices.
 *
 * @param {string} phcId
 * @returns {Promise<Array<{userId: string, token: string, language: string}>>}
 */
async function recipientsForPhc(phcId) {
  if (!phcId) return [];

  const recipients = await User.find({
    phc: phcId,
    // Doctors only. Not CLINICAL_ROLES, which also contains 'officer' — see above.
    role: 'doctor',
    isActive: true,
    // Skips users with no registered device, so the query returns only useful rows.
    'pushTokens.0': { $exists: true },
  })
    // `+pushTokens` is required: the field is `select: false` in the schema.
    .select('_id language +pushTokens')
    .lean();

  return recipients.flatMap((recipient) =>
    (recipient.pushTokens ?? []).map((entry) => ({
      userId: String(recipient._id),
      token: entry.token,
      language: ['bn', 'hi', 'en'].includes(recipient.language) ? recipient.language : 'bn',
    })),
  );
}

/** Drops tokens FCM reported as permanently dead. */
async function pruneDeadTokens(deadTokens) {
  if (deadTokens.length === 0) return;
  await User.updateMany(
    { 'pushTokens.token': { $in: deadTokens } },
    { $pull: { pushTokens: { token: { $in: deadTokens } } } },
  );
  console.log(`[push] pruned ${deadTokens.length} dead token(s)`);
}

/**
 * Sends the high-risk notification to every doctor at the PHC.
 *
 * Returns a summary rather than throwing. The caller is the assessment write path, and a
 * patient's screening must succeed whether or not a notification could be delivered.
 *
 * @param {object} args
 * @param {object} args.assessment stored assessment document
 * @param {object} args.patient    stored patient document
 * @param {string} args.phcId
 */
export async function sendHighRiskPush({ assessment, patient, phcId }) {
  if (!isPushConfigured()) return { sent: 0, skipped: 'NOT_CONFIGURED' };

  try {
    const app = await getFirebaseApp();
    if (!app) return { sent: 0, skipped: 'NOT_CONFIGURED' };

    const recipients = await recipientsForPhc(phcId);
    if (recipients.length === 0) return { sent: 0, skipped: 'NO_DEVICES' };

    const { getMessaging } = await import('firebase-admin/messaging');
    const messaging = getMessaging(app);

    /**
     * Grouped by the recipient's language, one multicast per group, so each doctor's phone
     * shows the notification in the language their account is set to. In practice a PHC is
     * usually one language, so this is normally a single send.
     */
    const byLanguage = new Map();
    for (const recipient of recipients.slice(0, MAX_TOKENS_PER_SEND)) {
      if (!byLanguage.has(recipient.language)) byLanguage.set(recipient.language, []);
      byLanguage.get(recipient.language).push(recipient.token);
    }

    /**
     * `data`-only, with no `notification` block.
     *
     * That is deliberate. A `notification` payload makes the browser render the alert
     * itself, using whatever text the server put in it — which would be English, because
     * the server does not know which of three languages this particular doctor reads. A
     * data-only message hands the payload to the service worker, which renders it through
     * the same i18n files as the rest of the app.
     *
     * Consequence to be aware of: data-only messages are delivered to the service worker's
     * `onBackgroundMessage`, and it MUST call showNotification itself. If it does not,
     * Chrome eventually shows a generic "site updated in the background" notice instead.
     *
     * Values must all be strings; FCM rejects numbers and booleans in `data`.
     */
    const baseData = {
      type: 'high-risk',
      assessmentId: String(assessment._id),
      patientName: String(patient.name ?? ''),
      patientAge: String(patient.age ?? ''),
      village: String(patient.village ?? ''),
      riskBand: String(assessment.riskBand),
      riskPercent: String(assessment.riskPercent),
      phcId: String(phcId),
      capturedAt: new Date(assessment.capturedAt).toISOString(),
      url: '/dashboard',
    };

    let sent = 0;
    let failed = 0;
    const dead = [];
    const failureCodes = new Set();

    for (const [language, tokens] of byLanguage) {
      const response = await messaging.sendEachForMulticast({
        tokens,
        data: { ...baseData, language },
        webpush: {
          headers: {
            // High urgency: the point of this feature is reaching a closed tab promptly.
            Urgency: 'high',
            TTL: String(config.pushTtlSeconds),
          },
          fcmOptions: { link: '/dashboard' },
        },
      });

      sent += response.successCount;
      failed += response.failureCount;

      response.responses.forEach((result, index) => {
        if (result.success) return;
        const code = result.error?.code ?? 'unknown';
        failureCodes.add(code);
        if (DEAD_TOKEN_CODES.has(code)) dead.push(tokens[index]);
      });
    }

    // Prune anything permanently dead so the next send is not doing wasted work.
    await pruneDeadTokens(dead);

    if (failed > 0) {
      console.warn(
        `[push] high-risk alert: ${sent} sent, ${failed} failed (${[...failureCodes].join(', ')})`,
      );
    }

    return {
      sent,
      failed,
      pruned: dead.length,
      devices: recipients.length,
      languages: [...byLanguage.keys()],
    };
  } catch (error) {
    // Never propagate: the screening this came from has already been stored successfully.
    console.error(`[push] failed to send high-risk alert: ${error?.message}`);
    return { sent: 0, error: error?.code || 'SEND_FAILED' };
  }
}

/** Status for /api/health, mirroring firebaseStatus(). */
export function pushStatus() {
  return {
    configured: isPushConfigured(),
    enabled: config.pushEnabled,
    maxTokensPerUser: config.pushMaxTokensPerUser,
  };
}
