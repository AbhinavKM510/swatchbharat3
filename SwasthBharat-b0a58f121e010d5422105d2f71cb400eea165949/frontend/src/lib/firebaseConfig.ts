/**
 * Firebase configuration and pure helpers. Contains NO Firebase imports.
 *
 * WHY THIS IS A SEPARATE FILE FROM firebaseAuth.ts
 * ------------------------------------------------
 * This module is imported statically (the login screen needs to know whether to render the
 * SMS section before anything is clicked). `firebaseAuth.ts` is imported dynamically, and
 * ONLY dynamically, so the Firebase SDK lands in its own chunk and stays out of the
 * service worker's offline precache.
 *
 * Keeping them in one file broke exactly that. When a module is imported both statically
 * and dynamically, Rollup inlines it into the static importer's chunk and emits a second,
 * separately tree-shaken copy for the dynamic import. Measured result: a 0.10 kB chunk
 * containing `async function n(){}` — `signOutFirebase` reduced to a no-op because its
 * module-level `cachedAuth` had been shaken away as never-assigned — and the Firebase SDK
 * absent from the build entirely, so phone sign-in could not have worked at runtime.
 *
 * The split is therefore load-bearing, not organisational. Nothing that imports
 * `firebase/*` may be statically imported from application code.
 */

/**
 * All five values are needed for sign-in. They are NOT secrets: a Firebase web config
 * identifies the project and ships in every Firebase web app. The project is protected by
 * its authorised-domain list and by the backend verifying every ID token — not by these
 * being hidden. The service-account private key, which IS secret, exists only server-side.
 */
export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
};

/** Points the SDK at a local Auth emulator, e.g. "127.0.0.1:9099". Development only. */
export const authEmulatorHost = import.meta.env.VITE_FIREBASE_AUTH_EMULATOR_HOST ?? '';

/**
 * Web Push public key (VAPID), from Firebase console -> Project settings -> Cloud Messaging
 * -> Web Push certificates.
 *
 * Separate from the config above because the two Firebase features are independent: a
 * project can have phone sign-in with no Web Push certificate, or the reverse. Background
 * notifications require this AND a complete config; phone sign-in does not need it at all.
 *
 * It is a public key. The matching private half stays with Firebase.
 */
export const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY ?? '';

/** Container id the invisible reCAPTCHA attaches to. Must be in the DOM before sending. */
export const RECAPTCHA_CONTAINER_ID = 'firebase-recaptcha-container';

/**
 * Whether to offer phone sign-in at all.
 *
 * Requires a complete config AND an explicit opt-in. The second condition exists because
 * the same project may be used for push notifications while phone auth is disabled or out
 * of SMS quota — in which case a visible button produces a confusing failure rather than an
 * absent feature.
 */
export function isPhoneSignInAvailable(): boolean {
  const complete = Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.authDomain &&
      firebaseConfig.projectId &&
      firebaseConfig.appId,
  );
  return complete && import.meta.env.VITE_ENABLE_PHONE_SIGNIN === 'true';
}

/**
 * Converts the app's 10-digit national phone format into the E.164 form Firebase requires.
 *
 * Hard-codes +91. This is a single-country pilot and a country picker would be speculative;
 * the backend independently rejects anything that does not normalise to a valid Indian
 * mobile number, so a wrong assumption here fails safely instead of creating a stray
 * account.
 */
export function toE164(phone: string): string {
  const digits = String(phone || '').replace(/\D/g, '');
  const national = digits.length > 10 ? digits.slice(-10) : digits;
  return `+91${national}`;
}
