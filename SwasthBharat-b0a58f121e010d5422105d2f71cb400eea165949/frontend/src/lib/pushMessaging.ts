/**
 * Background push notifications, client side.
 *
 * IMPORT DYNAMICALLY ONLY, like lib/firebaseAuth.ts. The Firebase SDK must stay out of the
 * main chunk so it is not precached for offline use — a notification feature cannot work
 * offline, so paying for it in the offline bundle is pure waste. See `manualChunks` and
 * `workbox.globIgnores` in vite.config.ts, which keep the SDK chunk out of the precache.
 *
 * WHY THIS IS OFF BY DEFAULT
 * -------------------------
 * A PHC doctor is not watching the dashboard, so a notification is genuinely useful — but the
 * same doctor is often sitting with a patient, and an unexpected alert mid-consultation is
 * worse than a missed one. Opt-in, remembered per device.
 *
 * There is also a hard browser constraint: `Notification.requestPermission()` must be called
 * from a user gesture. Asking on page load gets the prompt dismissed or permanently blocked,
 * which is unrecoverable without the user digging through site settings.
 */

import { api } from './api';
import { firebaseConfig, vapidKey } from './firebaseConfig';

const STORAGE_KEY = 'swasthbharat.pushAlerts';
/** The token this device last registered, so it can be unregistered on sign-out. */
const TOKEN_KEY = 'swasthbharat.pushToken';

/** Scope Firebase uses for its own worker. Separate from the Workbox worker at '/'. */
const MESSAGING_SW_URL = '/firebase-messaging-sw.js';
const MESSAGING_SW_SCOPE = '/firebase-cloud-messaging-push-scope';

export type PushSupport =
  | { supported: true }
  | { supported: false; reason: 'browser' | 'not-configured' | 'insecure-context' };

/**
 * Whether background notifications can work here at all.
 *
 * Distinguishes the reasons because they need different messages: an unsupported browser is
 * the user's situation to know about, an unconfigured server is the operator's problem, and
 * an insecure context is almost always someone testing over plain HTTP on a LAN address —
 * which is worth saying explicitly, because it looks like a broken feature otherwise.
 */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return { supported: false, reason: 'browser' };

  if (!window.isSecureContext) return { supported: false, reason: 'insecure-context' };

  const hasApis =
    'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  if (!hasApis) return { supported: false, reason: 'browser' };

  if (!firebaseConfig.projectId || !firebaseConfig.apiKey || !vapidKey) {
    return { supported: false, reason: 'not-configured' };
  }

  return { supported: true };
}

export function isPushEnabled(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

function rememberPreference(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, 'on');
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Preference will not survive a reload. Not fatal.
  }
}

function rememberToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Then it cannot be unregistered later; the server prunes dead tokens anyway.
  }
}

export function lastRegisteredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Current browser permission, without prompting. */
export function notificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

/**
 * Registers Firebase's own service worker, explicitly and at its own scope.
 *
 * Registered by hand and passed to `getToken` rather than letting the SDK find it, for one
 * reason: the SDK's default lookup can attach to whichever worker is controlling the page,
 * which here is the Workbox one. Naming both the URL and the scope keeps the two workers
 * separate, so the app's offline behaviour — verified working on real hardware — cannot be
 * disturbed by this feature.
 */
async function registerMessagingWorker(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(MESSAGING_SW_SCOPE);
  if (existing) return existing;

  return navigator.serviceWorker.register(MESSAGING_SW_URL, { scope: MESSAGING_SW_SCOPE });
}

export type EnableResult =
  | { ok: true; deviceCount: number }
  | { ok: false; reason: 'denied' | 'dismissed' | 'unsupported' | 'server' | 'failed' };

/**
 * Asks for permission, obtains a token, and registers it with the API.
 *
 * MUST be called from a user gesture — see the note at the top of this file.
 *
 * The order matters. Permission first, because everything after it is pointless without it.
 * Server registration last, because a token the backend does not know about is useless, and
 * if that call fails the preference is left OFF so the toggle honestly reflects reality
 * rather than claiming success.
 */
export async function enablePushAlerts(): Promise<EnableResult> {
  const support = pushSupport();
  if (!support.supported) return { ok: false, reason: 'unsupported' };

  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    return { ok: false, reason: 'failed' };
  }

  if (permission === 'denied') return { ok: false, reason: 'denied' };
  if (permission !== 'granted') return { ok: false, reason: 'dismissed' };

  try {
    const registration = await registerMessagingWorker();

    const [{ initializeApp, getApps }, { getMessaging, getToken }] = await Promise.all([
      import('firebase/app'),
      import('firebase/messaging'),
    ]);

    const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
    const token = await getToken(getMessaging(app), {
      vapidKey,
      serviceWorkerRegistration: registration,
    });

    if (!token) return { ok: false, reason: 'failed' };

    const response = await api.notifications.registerToken(token);
    rememberToken(token);
    rememberPreference(true);
    return { ok: true, deviceCount: response.deviceCount };
  } catch (error) {
    // A 501 here means the server has push switched off. Anything else is a genuine failure.
    const status = (error as { status?: number })?.status;
    return { ok: false, reason: status === 501 ? 'server' : 'failed' };
  }
}

/**
 * Turns notifications off for this device.
 *
 * Deletes the FCM token as well as unregistering it server-side. Leaving the token alive
 * would mean the browser still holds a valid push subscription — so a stale server row, or
 * a different deployment sharing the project, could still deliver to a device whose user
 * has explicitly said no.
 *
 * The browser permission itself is deliberately not revoked: no API can, and asking the
 * user to do it through site settings would be a worse experience than simply not sending.
 */
export async function disablePushAlerts(): Promise<void> {
  const token = lastRegisteredToken();
  rememberPreference(false);

  if (token) {
    // Best effort. Even if the API is unreachable, the local token is deleted below and the
    // server prunes tokens FCM reports as dead.
    await api.notifications.unregisterToken(token).catch(() => undefined);
  }

  try {
    const [{ initializeApp, getApps }, { getMessaging, deleteToken }] = await Promise.all([
      import('firebase/app'),
      import('firebase/messaging'),
    ]);
    const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);
    await deleteToken(getMessaging(app));
  } catch {
    // Nothing further to do; the preference is already off.
  }

  rememberToken(null);
}

/**
 * Re-registers on load when the user has already opted in.
 *
 * Necessary because FCM rotates tokens: one obtained weeks ago may no longer be the token
 * this browser would present, and the server would be pushing into a void. Cheap to call —
 * it does nothing unless the preference is on and permission is still granted.
 */
export async function refreshPushRegistration(): Promise<void> {
  if (!isPushEnabled()) return;
  if (notificationPermission() !== 'granted') return;
  if (!pushSupport().supported) return;

  await enablePushAlerts().catch(() => undefined);
}
