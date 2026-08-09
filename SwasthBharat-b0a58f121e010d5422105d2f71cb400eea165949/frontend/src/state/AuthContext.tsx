/**
 * Authentication state.
 *
 * ### The offline problem this solves
 *
 * A JWT lives in localStorage, and `GET /api/auth/me` validates it on boot. But a field
 * worker opening the app in a village with no signal cannot reach `/auth/me` — and locking
 * them out of an offline-first app because the network is down would defeat the entire
 * point.
 *
 * So the last known user profile is cached locally, and boot works like this:
 *
 *   - token + successful /auth/me  -> authenticated, profile refreshed
 *   - token + network failure      -> authenticated from the cached profile, offline
 *   - token + 401 from the server  -> genuinely rejected, log out
 *   - no token                     -> unauthenticated
 *
 * Distinguishing "the server said no" from "I could not ask the server" is the whole trick.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, api, setToken, setUnauthorizedHandler } from '@/lib/api';
import { clearLocalData } from '@/lib/db';
import { disconnectSocket } from '@/lib/socket';
import { syncManager } from '@/lib/sync';
import { useI18n, type Language } from '@/i18n';
import type { Role, User } from '@/types';

const CACHED_USER_KEY = 'swasthbharat.user';

export interface RegisterInput {
  name: string;
  phone: string;
  password: string;
  role: Role;
  language: Language;
  phcCode: string;
  /** Only used for doctor / officer. Verified server-side. */
  setupToken?: string;
}

function readCachedUser(): User | null {
  try {
    const raw = window.localStorage.getItem(CACHED_USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

function writeCachedUser(user: User | null): void {
  try {
    if (user) window.localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    else window.localStorage.removeItem(CACHED_USER_KEY);
  } catch {
    // Storage blocked. Session will not survive a reload; acceptable.
  }
}

export interface AuthContextValue {
  user: User | null;
  /** True until the initial session check finishes. */
  initialising: boolean;
  /** True when the session was restored from cache because the server was unreachable. */
  restoredOffline: boolean;
  login: (phone: string, password: string) => Promise<User>;
  /**
   * Creates an account and signs straight in with the session the server returns.
   *
   * Deliberately does not ask the user to log in again afterwards. The password was typed
   * (twice) moments ago, the server already issued a JWT, and a "now log in" step is a place
   * for someone to mistype and lose the account they just made.
   */
  register: (input: RegisterInput) => Promise<User>;
  /**
   * Completes sign-in from a Firebase phone-OTP ID token.
   *
   * Takes a token rather than a phone and code so this context stays unaware of Firebase:
   * the login screen owns the OTP dance, this owns the session.
   */
  loginWithFirebase: (idToken: string) => Promise<User>;
  logout: () => Promise<{ blockedByUnsyncedRecords: number }>;
  /** Forced sign-out, used when the server rejects the token mid-session. */
  forceLogout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { setLanguage } = useI18n();
  const [user, setUser] = useState<User | null>(null);
  const [initialising, setInitialising] = useState(true);
  const [restoredOffline, setRestoredOffline] = useState(false);

  const applyUser = useCallback(
    (next: User | null, options: { adoptLanguage?: boolean } = {}) => {
      setUser(next);
      writeCachedUser(next);
      void syncManager.setUser(next?.id ?? null);

      // On login, adopt the language stored on the account. A worker picking up a
      // replacement handset should not have to find the language switcher first.
      if (next && options.adoptLanguage) setLanguage(next.language as Language);
    },
    [setLanguage],
  );

  const forceLogout = useCallback(() => {
    setToken(null);
    disconnectSocket();
    applyUser(null);
  }, [applyUser]);

  // Any 401 from any request drops the session exactly once.
  useEffect(() => {
    setUnauthorizedHandler(() => forceLogout());
    return () => setUnauthorizedHandler(null);
  }, [forceLogout]);

  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      const cached = readCachedUser();

      try {
        const { user: fresh } = await api.auth.me();
        if (cancelled) return;
        applyUser(fresh);
        setRestoredOffline(false);
      } catch (error) {
        if (cancelled) return;

        if (error instanceof ApiError && error.isAuthError) {
          // The server actively rejected the token. Clear everything.
          setToken(null);
          applyUser(null);
        } else if (cached) {
          // Could not ask the server. Trust the cached profile and carry on offline —
          // this is what keeps the app usable in a village with no signal.
          applyUser(cached);
          setRestoredOffline(true);
        } else {
          applyUser(null);
        }
      } finally {
        if (!cancelled) setInitialising(false);
      }
    }

    // Skip the round trip entirely when there is no token to check.
    if (!readCachedUser() && !window.localStorage.getItem('swasthbharat.token')) {
      setInitialising(false);
      return () => {
        cancelled = true;
      };
    }

    void restoreSession();
    return () => {
      cancelled = true;
    };
  }, [applyUser]);

  const login = useCallback(
    async (phone: string, password: string) => {
      const { token, user: loggedIn } = await api.auth.login(phone, password);
      setToken(token);
      applyUser(loggedIn, { adoptLanguage: true });
      setRestoredOffline(false);
      return loggedIn;
    },
    [applyUser],
  );

  /**
   * Sign-up, then straight into the session.
   *
   * `adoptLanguage` is passed for the same reason as login, and it matters more here: the
   * language chosen during sign-up is stored on the account, so the next device this worker
   * picks up comes up in their script without them hunting for the switcher.
   */
  const register = useCallback(
    async (input: RegisterInput) => {
      const { token, user: created } = await api.auth.register(input);
      setToken(token);
      applyUser(created, { adoptLanguage: true });
      setRestoredOffline(false);
      return created;
    },
    [applyUser],
  );

  /**
   * Same session handling as the password path, from a different proof of identity.
   *
   * Note what is identical: the token stored, the profile cached, the language adopted.
   * The backend returns its own JWT from both routes, so nothing downstream — the socket
   * handshake, the sync queue, the offline restore — needs to know which was used. That is
   * the payoff for exchanging the Firebase token at the edge instead of carrying it around.
   *
   * The Firebase session is dropped immediately: once we hold the app's JWT, a second live
   * credential on a shared field handset is only a liability.
   */
  const loginWithFirebase = useCallback(
    async (idToken: string) => {
      const { token, user: loggedIn } = await api.auth.firebase(idToken);
      setToken(token);
      applyUser(loggedIn, { adoptLanguage: true });
      setRestoredOffline(false);

      const { signOutFirebase } = await import('@/lib/firebaseAuth');
      void signOutFirebase();

      return loggedIn;
    },
    [applyUser],
  );

  /**
   * Signs out, but refuses while records are still queued.
   *
   * Field phones are shared. Clearing local data with a day's screenings still unsent would
   * destroy real patient records, so the caller is told how many are waiting and the user
   * is kept signed in until they sync.
   */
  const logout = useCallback(async () => {
    if (user) {
      const { cleared, unsynced } = await clearLocalData(user.id);
      if (!cleared) return { blockedByUnsyncedRecords: unsynced };
    }
    setToken(null);
    disconnectSocket();
    applyUser(null);
    return { blockedByUnsyncedRecords: 0 };
  }, [applyUser, user]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      initialising,
      restoredOffline,
      login,
      register,
      loginWithFirebase,
      logout,
      forceLogout,
    }),
    [user, initialising, restoredOffline, login, register, loginWithFirebase, logout, forceLogout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
