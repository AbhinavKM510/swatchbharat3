/**
 * HTTP client for the SwasthBharat API.
 *
 * Two things this deliberately does NOT do:
 *
 * 1. It does not retry, and it does not queue. Offline durability is the job of
 *    `db.ts` + `sync.ts`: a failed write goes into IndexedDB, not into a retry loop that
 *    dies with the page. Mixing the two produces records that exist in neither place.
 *
 * 2. It does not translate error messages. It surfaces the server's stable `code`, and the
 *    UI renders text in the user's language from that code.
 */

import type {
  Assessment,
  DashboardSummary,
  DistrictTrends,
  ModelCard,
  Paginated,
  Patient,
  PhcOption,
  Role,
  SyncResponse,
  Teleconsult,
  User,
} from '@/types';
import type { ChatbotAnswer, ChatbotLanguage } from '@shared/chatbot/index.js';

/** Empty by default: dev goes through the Vite proxy, so requests stay same-origin. */
const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

const TOKEN_STORAGE_KEY = 'swasthbharat.token';

export interface FieldError {
  field: string;
  code: string;
  i18nKey: string;
  params?: Record<string, unknown>;
}

/** Error carrying the server's stable code so the UI can pick a translated message. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldError[];

  constructor(status: number, code: string, message: string, fields: FieldError[] = []) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }

  /** True when the request never reached the server (offline, DNS, connection refused). */
  get isNetworkError(): boolean {
    return this.status === 0;
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }
}

/* Token storage ----------------------------------------------------------- */

let inMemoryToken: string | null = null;

export function getToken(): string | null {
  if (inMemoryToken) return inMemoryToken;
  try {
    inMemoryToken = window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    inMemoryToken = null;
  }
  return inMemoryToken;
}

export function setToken(token: string | null): void {
  inMemoryToken = token;
  try {
    if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Storage blocked: the session simply will not survive a reload.
  }
}

/** Called when a 401 comes back, so the app can drop to the login screen once. */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

/**
 * Called with the observed reachability of the server after every request attempt.
 *
 * `navigator.onLine` only reports whether a network interface is up, which on a rural
 * connection regularly means "attached to a tower that is not passing traffic" — and the
 * browser fires no `offline` event for that. A request that actually completed (or actually
 * failed to connect) is direct evidence, so it is the better signal for the connection
 * indicator.
 *
 * Registered by the sync manager rather than imported, because `sync.ts` already imports
 * this module and a reverse import would be circular.
 */
type ConnectivityObserver = (reachable: boolean) => void;
let onConnectivityChange: ConnectivityObserver | null = null;

export function setConnectivityObserver(observer: ConnectivityObserver | null): void {
  onConnectivityChange = observer;
}

/* Core request ------------------------------------------------------------ */

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Skip the Authorization header (used for login and the public chatbot). */
  anonymous?: boolean;
  signal?: AbortSignal;
  /** Milliseconds before the request is abandoned. Field connections are slow but finite. */
  timeoutMs?: number;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, anonymous = false, signal, timeoutMs = 20000 } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  const token = anonymous ? null : getToken();

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof DOMException && error.name === 'AbortError';
    // A rejected fetch means the request never reached the server. A timeout is left alone:
    // a slow tower is still a tower, and flipping the whole app to "offline" because one
    // request took 20s would misreport a connection that is merely bad.
    if (!aborted) onConnectivityChange?.(false);
    throw new ApiError(
      0,
      aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
      aborted ? 'The request timed out' : 'Could not reach the server',
    );
  }
  clearTimeout(timer);

  // Any HTTP response — including 4xx and 5xx — proves the server was reachable.
  onConnectivityChange?.(true);

  if (response.status === 204) return undefined as T;

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errorBody = (payload as { error?: { code?: string; message?: string; details?: { fields?: FieldError[] } } })
      ?.error;

    if (response.status === 401 && !anonymous) {
      setToken(null);
      onUnauthorized?.();
    }

    throw new ApiError(
      response.status,
      errorBody?.code ?? 'UNKNOWN_ERROR',
      errorBody?.message ?? `Request failed with status ${response.status}`,
      errorBody?.details?.fields ?? [],
    );
  }

  return payload as T;
}

/* Endpoints --------------------------------------------------------------- */

export const api = {
  health: () =>
    request<{ status: string; database: { state: string }; realtime: { connectedSockets: number } }>(
      '/api/health',
      { anonymous: true, timeoutMs: 6000 },
    ),

  modelCard: () => request<ModelCard>('/api/model', { anonymous: true }),

  auth: {
    login: (phone: string, password: string) =>
      request<{ token: string; user: User }>('/api/auth/login', {
        method: 'POST',
        body: { phone, password },
        anonymous: true,
      }),

    /**
     * Trades a Firebase phone-OTP ID token for this app's own JWT.
     *
     * Answers 501 FIREBASE_NOT_CONFIGURED when the server has no Firebase project, which
     * callers must handle: phone sign-in is optional and most deployments will not have it.
     */
    firebase: (idToken: string) =>
      request<{ token: string; user: User; signInMethod: string }>('/api/auth/firebase', {
        method: 'POST',
        body: { idToken },
        anonymous: true,
      }),

    /**
     * Creates an account and returns a session, so sign-up lands the user straight in.
     *
     * `setupToken` is only meaningful for `doctor` and `officer`. The server rejects those
     * roles with 403 SETUP_TOKEN_REQUIRED when it is missing or wrong — that check is
     * server-side on purpose, since a client-side role gate is a suggestion, not a control.
     */
    register: (input: {
      name: string;
      phone: string;
      password: string;
      role: Role;
      language: 'bn' | 'hi' | 'en';
      phcCode: string;
      setupToken?: string;
    }) =>
      request<{ token: string; user: User }>('/api/auth/register', {
        method: 'POST',
        body: input,
        anonymous: true,
      }),

    /** PHC dropdown options for the sign-up form. Public, because sign-up precedes a token. */
    phcs: () =>
      request<{ items: PhcOption[] }>('/api/auth/phcs', { anonymous: true }),

    me: () => request<{ user: User }>('/api/auth/me'),

    setLanguage: (language: 'bn' | 'hi' | 'en') =>
      request<{ user: User }>('/api/auth/me/language', { method: 'PATCH', body: { language } }),
  },

  /**
   * Background push notification device registration.
   *
   * Note what is absent: there is no way to specify a PHC, a topic, or a recipient. A device
   * can only ever register itself against the authenticated account, and the server decides
   * who receives which alert. See backend/src/services/pushService.js.
   */
  notifications: {
    status: () =>
      request<{
        configured: boolean;
        enabled: boolean;
        maxTokensPerUser: number;
        deviceCount: number;
      }>('/api/notifications/status'),

    registerToken: (token: string) =>
      request<{ registered: boolean; deviceCount: number }>('/api/notifications/token', {
        method: 'POST',
        body: { token },
      }),

    unregisterToken: (token: string) =>
      request<{ removed: boolean }>('/api/notifications/token', {
        method: 'DELETE',
        body: { token },
      }),
  },

  patients: {
    list: (params: { search?: string; village?: string; limit?: number; page?: number } = {}) => {
      const query = new URLSearchParams();
      if (params.search) query.set('search', params.search);
      if (params.village) query.set('village', params.village);
      if (params.limit) query.set('limit', String(params.limit));
      if (params.page) query.set('page', String(params.page));
      const suffix = query.toString() ? `?${query}` : '';
      return request<Paginated<Patient>>(`/api/patients${suffix}`);
    },

    get: (id: string) =>
      request<{ patient: Patient; assessments: Assessment[] }>(`/api/patients/${id}`),
  },

  assessments: {
    /** Score without storing. The offline path uses the bundled engine instead. */
    score: (input: unknown) =>
      request<{ result: unknown; stored: false }>('/api/assessments/score', {
        method: 'POST',
        body: input,
      }),

    create: (record: unknown) =>
      request<{ status: 'created' | 'duplicate'; assessment: Assessment }>('/api/assessments', {
        method: 'POST',
        body: record,
      }),

    /** Batch upload of records captured offline. Idempotent on each record's clientId. */
    sync: (records: unknown[]) =>
      request<SyncResponse>('/api/assessments/sync', {
        method: 'POST',
        body: { records },
        // A queue that built up over a day can be large and the connection poor.
        timeoutMs: 60000,
      }),

    list: (
      params: {
        band?: string;
        status?: string;
        limit?: number;
        page?: number;
        /** Restrict to records the caller created. Used by the post-login device restore. */
        mine?: boolean;
      } = {},
    ) => {
      const query = new URLSearchParams();
      if (params.band) query.set('band', params.band);
      if (params.status) query.set('status', params.status);
      if (params.limit) query.set('limit', String(params.limit));
      if (params.page) query.set('page', String(params.page));
      if (params.mine) query.set('mine', 'true');
      const suffix = query.toString() ? `?${query}` : '';
      return request<Paginated<Assessment>>(`/api/assessments${suffix}`);
    },

    get: (id: string) => request<{ assessment: Assessment }>(`/api/assessments/${id}`),

    review: (id: string, reviewStatus: string, reviewNote: string) =>
      request<{ assessment: Assessment }>(`/api/assessments/${id}/review`, {
        method: 'PATCH',
        body: { reviewStatus, reviewNote },
      }),
  },

  dashboard: {
    flagged: (params: { band?: string; status?: string; limit?: number } = {}) => {
      const query = new URLSearchParams();
      query.set('band', params.band ?? 'HIGH');
      query.set('status', params.status ?? 'open');
      if (params.limit) query.set('limit', String(params.limit));
      return request<{ items: Assessment[]; count: number }>(`/api/dashboard/flagged?${query}`);
    },

    summary: () => request<DashboardSummary>('/api/dashboard/summary'),
  },

  district: {
    trends: (days = 30) => request<DistrictTrends>(`/api/district/trends?days=${days}`),
    phcs: () => request<{ items: import('@/types').Phc[] }>('/api/district/phcs'),
  },

  chatbot: {
    ask: (question: string, language: ChatbotLanguage) =>
      request<{ answer: ChatbotAnswer }>('/api/chatbot/ask', {
        method: 'POST',
        body: { question, language },
        anonymous: true,
        timeoutMs: 8000,
      }),

    /** Replays questions the device answered offline, for the unmatched-question backlog. */
    sync: (questions: { question: string; language: string; askedAt: string }[]) =>
      request<{ stored: number; received: number }>('/api/chatbot/sync', {
        method: 'POST',
        body: { questions },
      }),
  },

  teleconsult: {
    request: (payload: {
      clientId: string;
      patientId: string;
      assessmentId?: string | null;
      reason?: string;
      preferredLanguage?: string;
    }) =>
      request<{ status: string; teleconsult: Teleconsult; simulationNotice: string }>(
        '/api/teleconsult',
        { method: 'POST', body: payload },
      ),

    list: (status?: string) =>
      request<{ items: Teleconsult[]; simulationNotice: string }>(
        `/api/teleconsult${status ? `?status=${status}` : ''}`,
      ),

    setStatus: (id: string, status: string, extra: { notes?: string; durationSeconds?: number } = {}) =>
      request<{ teleconsult: Teleconsult }>(`/api/teleconsult/${id}/status`, {
        method: 'PATCH',
        body: { status, ...extra },
      }),

    capabilities: () =>
      request<Record<string, { implemented: boolean; note: string }>>('/api/teleconsult/capabilities'),
  },
};
