/**
 * Background sync.
 *
 * Drains the IndexedDB queue to the server whenever a connection is available, and keeps
 * the UI honestly informed about what is still waiting.
 *
 * ### Why `navigator.onLine` is not trusted on its own
 *
 * `navigator.onLine === true` only means the device has *a* network interface up. On a
 * rural connection that regularly means "connected to a tower that is not passing
 * traffic". So a sync attempt is also triggered by events that correlate with real
 * connectivity returning (tab focus, visibility), and a failed attempt simply returns the
 * records to the queue rather than marking them broken.
 *
 * ### Failure classification matters
 *
 * There are two completely different failures and treating them the same would be a bug:
 *
 *   - **Transport failure** (offline, timeout, 5xx): the record is fine, the network is
 *     not. Return it to `pending` and retry later, forever if necessary.
 *   - **Record rejection** (400 with field errors): the record will never be accepted, so
 *     retrying is pointless. Mark it `failed` and surface it so a human can fix or discard
 *     it. Retrying these would jam the queue behind an entry that can never drain.
 */

import { api, ApiError } from '@/lib/api';
import {
  countByState,
  importServerAssessments,
  listUnsyncedAssessments,
  listUnsyncedChatQuestions,
  markChatQuestionsSynced,
  markFailed,
  markPendingAgain,
  markSynced,
  getMeta,
  setMeta,
  type LocalAssessment,
} from '@/lib/db';

const LAST_SYNCED_META_KEY = 'lastSyncedAt';
const BATCH_SIZE = 50;

/**
 * How many of the worker's own past screenings to pull back down on login.
 *
 * 200 is the server's per-page ceiling, so this is one request. Records come back newest
 * first, which is what the two things reading them need: the "today" counters and a
 * ten-item recent list. A worker with more history than this keeps the most recent 200 on
 * the device and the rest stays on the server, where the Patients tab already reads it.
 */
const RESTORE_PAGE_SIZE = 200;

/** Retry cadence while records are waiting and the device believes it is online. */
const RETRY_INTERVAL_MS = 20000;

/**
 * How long the "just synced" confirmation stays on screen.
 *
 * Long enough that someone watching from across a room registers what happened, short
 * enough that it does not linger as permanent chrome.
 */
const SYNCED_BANNER_MS = 5000;

export interface SyncState {
  online: boolean;
  syncing: boolean;
  pending: number;
  failed: number;
  lastSyncedAt: string | null;
  /** Result of the most recent attempt, for a transient toast. */
  lastResult: { created: number; duplicates: number; failed: number } | null;
  /**
   * Set for a few seconds immediately after records actually reach the server, then
   * self-clears. Drives the visible confirmation on the connection strip — the queue
   * draining is the single strongest moment in the demo, and a counter quietly going to
   * zero is too subtle to read from a distance.
   */
  recentlySynced: { created: number; duplicates: number } | null;
  lastError: string | null;
  /**
   * Bumped when past screenings are downloaded back into the local store.
   *
   * Exists so screens that read IndexedDB can re-read once the rows land. Without it the
   * home page would query an empty table during login, get 0, and keep showing 0 until the
   * next navigation — the counters would still be wrong right after the fix, just for a
   * shorter time. `lastSyncedAt` cannot serve this purpose because the upload sets it
   * BEFORE the download runs.
   */
  lastRestoredAt: string | null;
}

type Listener = (state: SyncState) => void;

/**
 * Converts a stored record into the wire format the API expects.
 *
 * `deviceRiskBand` is included so the server can compare its own re-score against what
 * the device calculated. A mismatch means this device is running an outdated model bundle,
 * and the server flags the record instead of quietly disagreeing with what the worker was
 * shown in the field.
 */
function toWireRecord(record: LocalAssessment) {
  return {
    clientId: record.clientId,
    patient: {
      clientId: record.patientClientId,
      name: record.patientName,
      age: record.patientAge,
      sex: record.patientSex,
      phone: record.patientPhone,
      village: record.patientVillage,
      capturedAt: record.capturedAt,
    },
    input: record.input,
    capturedAt: record.capturedAt,
    language: record.language,
    inputMethod: record.inputMethod,
    deviceRiskBand: record.riskBand,
  };
}

class SyncManager {
  private listeners = new Set<Listener>();

  private userId: string | null = null;

  private timer: number | null = null;

  private syncedBannerTimer: number | null = null;

  private state: SyncState = {
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    syncing: false,
    pending: 0,
    failed: 0,
    lastSyncedAt: null,
    lastResult: null,
    recentlySynced: null,
    lastError: null,
    lastRestoredAt: null,
  };

  /** Guards against two flushes overlapping and double-sending a batch. */
  private flushing = false;

  constructor() {
    if (typeof window === 'undefined') return;

    window.addEventListener('online', this.handleOnline);
    window.addEventListener('offline', this.handleOffline);

    // Coming back to the tab is a strong hint that conditions changed — the worker has
    // probably just walked somewhere with signal.
    window.addEventListener('focus', this.handleWake);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.handleWake();
    });
  }

  /* Public API ------------------------------------------------------------ */

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState(): SyncState {
    return this.state;
  }

  /** Called after login/logout. Counts are per-user. */
  async setUser(userId: string | null): Promise<void> {
    this.userId = userId;
    if (!userId) {
      this.stopTimer();
      this.update({ pending: 0, failed: 0, lastResult: null });
      return;
    }
    this.update({ lastSyncedAt: await getMeta(LAST_SYNCED_META_KEY) });
    await this.refreshCounts();
    this.scheduleIfNeeded();

    /**
     * Upload first, then download.
     *
     * `flush` is awaited rather than fired off, so that by the time the restore runs the
     * queue has drained and the server's copy already includes anything this device was
     * holding. Restoring first would work too — `importServerAssessments` refuses to touch
     * unsent rows — but it would briefly show a worker their own just-captured screening as
     * absent from the recent list, which is exactly the confusion this is fixing.
     */
    await this.flush();
    await this.restoreFromServer(userId);
  }

  /**
   * Downloads this worker's own screenings back into IndexedDB.
   *
   * The home screen and the result page read only from the local store, and logout wipes it
   * for shared-handset privacy. Without this step a worker who logs out and back in sees
   * "0 screened today" and an empty recent list while their records sit safely on the server
   * — see the note on `importServerAssessments`.
   *
   * BEST EFFORT BY DESIGN. A failure here must never surface as an error or block the app:
   * offline is the normal working condition for this product, and in that case the local
   * store is already the right thing to be reading. `lastError` is deliberately not set,
   * because nothing the worker can do would help and the queue itself is fine.
   */
  private async restoreFromServer(userId: string): Promise<void> {
    if (!this.state.online) return;

    try {
      // `mine` matters for a doctor, whose server scope is the whole PHC: without it this
      // would pull every colleague's patients onto their device.
      const { items } = await api.assessments.list({ limit: RESTORE_PAGE_SIZE, mine: true });
      // The session can end while the request is in flight (logout, or a 401 forcing one).
      // Writing rows for a user who has just been cleared would put patient data back on a
      // handed-over phone, which is the precise thing logout exists to prevent.
      if (this.userId !== userId) return;

      const restored = await importServerAssessments(userId, items);
      if (restored > 0) {
        await this.refreshCounts();
        // Wakes the screens that read IndexedDB, so the counters fill in without the worker
        // having to navigate away and back.
        this.update({ lastRestoredAt: new Date().toISOString() });
      }
    } catch {
      // Offline, server down, or an expired token. All three are handled elsewhere.
    }
  }

  async refreshCounts(): Promise<void> {
    if (!this.userId) return;
    const { pending, failed } = await countByState(this.userId);
    this.update({ pending, failed });
    this.scheduleIfNeeded();
  }

  /**
   * Attempts to drain the queue.
   *
   * @param options.force ignore the `online` flag. Used by the manual "Sync now" button,
   *   because `navigator.onLine` is unreliable and the user pressing the button is better
   *   evidence than the browser's guess.
   */
  async flush(options: { force?: boolean } = {}): Promise<SyncState> {
    if (!this.userId) return this.state;
    if (this.flushing) return this.state;

    if (!this.state.online && !options.force) {
      /**
       * Offline: there is nothing to send, but the counters must STILL be reconciled
       * before returning.
       *
       * Returning early without this was a real bug with three consequences, all of them
       * on the offline path that matters most:
       *   1. the queue badge stayed at zero while records piled up, so the UI claimed
       *      everything was synced while holding unsent patient records;
       *   2. `scheduleIfNeeded()` never saw work, so the retry interval never started;
       *   3. `handleWake` keys off these counters, so the focus/visibility recovery path
       *      silently stopped working too.
       * That left reconnection recovery depending solely on the `online` event firing.
       */
      await this.refreshCounts();
      return this.state;
    }

    this.flushing = true;
    this.update({ syncing: true, lastError: null });

    try {
      await this.flushAssessments();
      await this.flushChatQuestions();

      const stamp = new Date().toISOString();
      await setMeta(LAST_SYNCED_META_KEY, stamp);
      this.update({ lastSyncedAt: stamp, online: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sync failed';
      this.update({ lastError: message });
      if (error instanceof ApiError && error.isNetworkError) this.update({ online: false });
    } finally {
      this.flushing = false;
      this.update({ syncing: false });
      await this.refreshCounts();
    }

    return this.state;
  }

  dispose(): void {
    this.stopTimer();
    if (this.syncedBannerTimer !== null) {
      window.clearTimeout(this.syncedBannerTimer);
      this.syncedBannerTimer = null;
    }
    this.listeners.clear();
  }

  /* Internals ------------------------------------------------------------- */

  private async flushAssessments(): Promise<void> {
    if (!this.userId) return;

    const queued = await listUnsyncedAssessments(this.userId, BATCH_SIZE);
    if (queued.length === 0) {
      this.update({ lastResult: null });
      return;
    }

    let response;
    try {
      response = await api.assessments.sync(queued.map(toWireRecord));
    } catch (error) {
      // Transport-level failure: nothing about these records is wrong, so put them all
      // back and try again later. Never mark them failed here.
      const message = error instanceof Error ? error.message : 'Network error';
      await Promise.all(queued.map((record) => markPendingAgain(record.clientId, message)));
      throw error;
    }

    for (const entry of response.results) {
      if (!entry.clientId) continue;

      if (entry.status === 'created' || entry.status === 'duplicate') {
        await markSynced(entry.clientId, {
          assessmentId: entry.assessmentId,
          patientId: entry.patientId ?? undefined,
        });
        continue;
      }

      // Rejected on content. Retrying will not help; make it visible instead.
      await markFailed(entry.clientId, entry.error?.code ?? 'REJECTED');
    }

    this.update({
      lastResult: {
        created: response.summary.created,
        duplicates: response.summary.duplicates,
        failed: response.summary.failed,
      },
    });

    this.announceSynced(response.summary.created, response.summary.duplicates);
  }

  /** Raises the transient "synced" confirmation, replacing any still on screen. */
  private announceSynced(created: number, duplicates: number): void {
    if (created === 0) return;

    this.update({ recentlySynced: { created, duplicates } });

    if (this.syncedBannerTimer !== null) window.clearTimeout(this.syncedBannerTimer);
    this.syncedBannerTimer = window.setTimeout(() => {
      this.update({ recentlySynced: null });
      this.syncedBannerTimer = null;
    }, SYNCED_BANNER_MS);
  }

  private async flushChatQuestions(): Promise<void> {
    const queued = await listUnsyncedChatQuestions();
    if (queued.length === 0) return;

    try {
      await api.chatbot.sync(
        queued.map((entry) => ({
          question: entry.question,
          language: entry.language,
          askedAt: entry.askedAt,
        })),
      );
      await markChatQuestionsSynced(
        queued.map((entry) => entry.localId).filter((id): id is number => typeof id === 'number'),
      );
    } catch {
      // Analytics only. A failure here must never surface to the user or block the
      // assessment queue, which is the part that actually matters.
    }
  }

  private handleOnline = () => {
    this.update({ online: true });
    void this.flush();
  };

  private handleOffline = () => {
    this.update({ online: false });
    // Reconcile immediately so the badge is accurate the moment coverage drops.
    void this.refreshCounts();
  };

  /**
   * Tab focus / visibility change.
   *
   * Reconciles counters from IndexedDB BEFORE deciding whether to flush. Trusting the
   * in-memory counters here was the third symptom of the offline bug above: if they were
   * stale at zero, this handler concluded there was nothing to send and did nothing —
   * disabling the one recovery path that does not depend on the `online` event.
   */
  private handleWake = () => {
    void (async () => {
      if (typeof navigator !== 'undefined') this.update({ online: navigator.onLine });
      await this.refreshCounts();
      if (this.state.pending > 0 || this.state.failed > 0) await this.flush();
    })();
  };

  private scheduleIfNeeded(): void {
    const hasWork = this.state.pending > 0;
    if (hasWork && this.timer === null) {
      this.timer = window.setInterval(() => {
        if (this.state.online) void this.flush();
      }, RETRY_INTERVAL_MS);
    } else if (!hasWork && this.timer !== null) {
      this.stopTimer();
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private update(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}

/** Single shared instance: two managers would double-send batches. */
export const syncManager = new SyncManager();
