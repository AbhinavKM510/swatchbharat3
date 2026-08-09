/**
 * Firebase phone-OTP sign-in. The only module in the app that imports the Firebase SDK.
 *
 * IMPORT THIS DYNAMICALLY, NEVER STATICALLY
 * -----------------------------------------
 * Every consumer must reach these functions through `await import('@/lib/firebaseAuth')`.
 * Configuration and pure helpers live in `firebaseConfig.ts` precisely so that nothing
 * needs a static import of this file.
 *
 * Two reasons, one of which is a bug that was actually hit:
 *
 *   1. Size. The Firebase Auth SDK is larger than this entire application. Statically
 *      imported it joins the main chunk, which the service worker precaches for offline
 *      use — so every field worker would download a sign-in SDK, over a 2G connection, to
 *      be able to open the app with no network. Phone sign-in needs the network anyway.
 *
 *   2. Correctness. Mixing a static and a dynamic import of the same module makes Rollup
 *      inline it into the static importer's chunk AND emit a second, separately
 *      tree-shaken copy for the dynamic import. That second copy had its own module-level
 *      `cachedAuth`, which was shaken away as never-assigned, reducing `signOutFirebase`
 *      to `async function n(){}` — a silent no-op leaving the Firebase session live. In the
 *      same build the SDK was dropped from the output entirely, so sign-in would have
 *      failed at runtime with no build error at all.
 *
 * WHY PASSWORD LOGIN REMAINS THE DEFAULT
 * --------------------------------------
 * OTP needs a working SMS path and a reachable Firebase project. Password login works
 * against a locally reachable API and is what every verification script exercises. This is
 * an addition, behind a flag, and the app is fully usable without it.
 */

import type { Auth, ConfirmationResult, RecaptchaVerifier } from 'firebase/auth';
import { RECAPTCHA_CONTAINER_ID, authEmulatorHost, firebaseConfig, toE164 } from './firebaseConfig';

type FirebaseAuthModule = typeof import('firebase/auth');

/**
 * Named explicitly rather than inferred from `loadAuth`. Inferring it is circular —
 * `cachedAuth`'s type would come from `loadAuth`'s return type, which is `cachedAuth` —
 * and TypeScript rejects that with TS2502.
 */
interface LoadedAuth {
  auth: Auth;
  authModule: FirebaseAuthModule;
}

let cachedAuth: LoadedAuth | null = null;

async function loadAuth(): Promise<LoadedAuth> {
  if (cachedAuth) return cachedAuth;

  const [{ initializeApp, getApps }, authModule] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
  ]);

  const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
  const auth = authModule.getAuth(app);

  if (authEmulatorHost) {
    // `disableWarnings` because the console banner is expected here and only adds noise.
    authModule.connectAuthEmulator(auth, `http://${authEmulatorHost}`, { disableWarnings: true });
  }

  // The device's own language, so a Bengali worker receives a Bengali SMS.
  auth.languageCode = document.documentElement.lang || 'en';

  cachedAuth = { auth, authModule };
  return cachedAuth;
}

let verifier: RecaptchaVerifier | null = null;

/**
 * Sends an SMS code and returns the confirmation handle.
 *
 * The reCAPTCHA verifier is created once and reused. Recreating it per attempt leaves
 * orphaned widgets in the DOM and makes Firebase throw about the container already being
 * rendered on the second attempt — which is exactly the moment it has to work, because the
 * second attempt is someone who mistyped their number.
 */
export async function sendOtp(phone: string): Promise<ConfirmationResult> {
  const { auth, authModule } = await loadAuth();

  if (!verifier) {
    verifier = new authModule.RecaptchaVerifier(auth, RECAPTCHA_CONTAINER_ID, { size: 'invisible' });
  }

  return authModule.signInWithPhoneNumber(auth, toE164(phone), verifier);
}

/**
 * Confirms the SMS code and returns the Firebase ID token for the backend to verify.
 *
 * Firebase's job ends here. `signOutFirebase()` is called straight afterwards: once the
 * backend has issued the application's own JWT, a second live credential sitting on a
 * shared field handset is only something to leak.
 */
export async function confirmOtp(confirmation: ConfirmationResult, code: string): Promise<string> {
  const credential = await confirmation.confirm(code);
  return credential.user.getIdToken();
}

/** Drops the Firebase session. The app's own JWT is the session from here on. */
export async function signOutFirebase(): Promise<void> {
  if (!cachedAuth) return;
  try {
    await cachedAuth.authModule.signOut(cachedAuth.auth);
  } catch {
    // Nothing actionable: the app's session does not depend on this succeeding.
  }
}

/** Clears the reCAPTCHA widget so a fresh attempt starts clean. */
export function resetOtpVerifier(): void {
  try {
    verifier?.clear();
  } catch {
    // Already torn down.
  }
  verifier = null;
}
