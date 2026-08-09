/**
 * Firebase Admin, initialised lazily and optional by design.
 *
 * WHAT FIREBASE IS AND IS NOT DOING HERE
 * --------------------------------------
 * Firebase Auth sits at the EDGE. It proves that whoever is calling controls a phone
 * number, and nothing more. It is not the session, not the authorisation model, and not
 * the user store.
 *
 * The flow is: the browser completes phone OTP with Firebase, sends the resulting ID token
 * to `POST /api/auth/firebase`, and that route exchanges it for the application's OWN JWT
 * via the existing `issueToken()`. Everything downstream — `requireAuth`, `requireRole`,
 * `scopeFilterFor`, `assertCanAccessRecord`, and the Socket.io handshake — is untouched and
 * does not know Firebase exists.
 *
 * That boundary is deliberate. The parts of this system that decide who may read a
 * patient's record are the parts most worth keeping small, reviewable and dependency-free.
 * Putting role and PHC scoping into Firebase custom claims would move the entire
 * cross-PHC isolation guarantee into a third-party token and a console UI, where it could
 * not be reviewed in this repository or tested by `check-security.mjs`.
 *
 * OPTIONAL BY DESIGN
 * ------------------
 * If Firebase is not configured, `POST /api/auth/firebase` returns a clear 501 and
 * everything else — including phone+password login and all 86 assertions — works exactly
 * as before. Nobody cloning this repo needs a Firebase project to run or verify the app.
 *
 * CREDENTIALS
 * -----------
 * Three ways to configure, checked in this order:
 *   1. FIREBASE_AUTH_EMULATOR_HOST  — local development and CI. No project, no network,
 *      no service account. Only FIREBASE_PROJECT_ID is needed.
 *   2. GOOGLE_APPLICATION_CREDENTIALS — the standard path to a service-account JSON file.
 *   3. FIREBASE_SERVICE_ACCOUNT      — the same JSON inline, for hosts that only offer
 *      environment variables. Base64 is accepted because a raw JSON blob with newlines is
 *      awkward to paste into most dashboards.
 *
 * The service-account JSON contains a private key. It must never be committed; .env is
 * already gitignored, and nothing here logs the key or the parsed object.
 */

import { config } from './env.js';

/** Cached across calls. `null` means "tried and unavailable". */
let adminApp;
let initialisationError = null;

/**
 * Reads the service account from either a file path or an inline (optionally base64)
 * environment variable.
 *
 * @returns {object|null} parsed credential, or null when only the emulator is configured
 */
function readServiceAccount() {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (inline && inline.trim()) {
    const raw = inline.trim();
    // Heuristic: a JSON object starts with '{'; anything else is treated as base64.
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT could not be parsed as JSON (raw or base64). ' +
          'Check it was pasted whole.',
      );
    }
  }
  return null;
}

/**
 * True when a Firebase phone-OTP exchange is possible.
 *
 * Note the emulator branch: with FIREBASE_AUTH_EMULATOR_HOST set, the Admin SDK talks to
 * the local emulator and verifies its unsigned tokens without any credential at all. That
 * is what lets the verification scripts exercise this path with no network and no project.
 */
export function isFirebaseConfigured() {
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) return Boolean(config.firebaseProjectId);
  return Boolean(
    config.firebaseProjectId &&
      (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_SERVICE_ACCOUNT),
  );
}

/**
 * Returns the initialised Admin app, or null if Firebase is not configured.
 *
 * Imported dynamically so `firebase-admin` — 154 transitive packages — is never loaded
 * into a process that is not using it. Startup stays fast and a deployment that does not
 * use Firebase carries no runtime cost.
 */
export async function getFirebaseApp() {
  if (adminApp !== undefined) return adminApp;
  if (initialisationError) throw initialisationError;

  if (!isFirebaseConfigured()) {
    adminApp = null;
    return null;
  }

  try {
    const { initializeApp, cert, applicationDefault, getApps } = await import('firebase-admin/app');

    // Reuse an app initialised elsewhere (e.g. by a test harness) rather than throwing.
    const existing = getApps();
    if (existing.length > 0) {
      adminApp = existing[0];
      return adminApp;
    }

    const serviceAccount = readServiceAccount();
    const usingEmulator = Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST);

    adminApp = initializeApp({
      projectId: config.firebaseProjectId,
      // The emulator accepts any credential; a real project needs a genuine one.
      ...(serviceAccount
        ? { credential: cert(serviceAccount) }
        : usingEmulator
          ? {}
          : { credential: applicationDefault() }),
    });

    return adminApp;
  } catch (error) {
    // Cached so a misconfiguration produces the same clear error every time rather than
    // retrying a failing import on every request.
    initialisationError = error;
    adminApp = undefined;
    throw error;
  }
}

/**
 * Verifies a Firebase ID token and returns its decoded claims.
 *
 * `checkRevoked` is true so a disabled or signed-out Firebase user cannot keep using an
 * ID token that has not yet expired. It costs one extra lookup per exchange, which is
 * acceptable: this runs once per login, not once per request — every subsequent request
 * carries the application's own JWT.
 *
 * @param {string} idToken
 * @returns {Promise<import('firebase-admin/auth').DecodedIdToken|null>} null if unconfigured
 */
export async function verifyFirebaseIdToken(idToken) {
  const app = await getFirebaseApp();
  if (!app) return null;

  const { getAuth } = await import('firebase-admin/auth');
  return getAuth(app).verifyIdToken(idToken, true);
}

/** One-line description of the Firebase state, for /api/health and startup logging. */
export function firebaseStatus() {
  if (!isFirebaseConfigured()) {
    return { configured: false, emulator: false, projectId: null };
  }
  return {
    configured: true,
    emulator: Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST),
    projectId: config.firebaseProjectId,
  };
}
