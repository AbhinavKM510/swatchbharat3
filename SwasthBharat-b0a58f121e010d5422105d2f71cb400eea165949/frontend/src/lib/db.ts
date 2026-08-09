/**
 * Local database (IndexedDB via Dexie).
 *
 * This is the core of the offline story. A screening is written HERE FIRST, always, before
 * any network call is attempted. The consequences of that ordering:
 *
 *   - A worker in a village with no signal completes a screening exactly as they would
 *     online, sees the risk result, and moves on. Nothing is lost and nothing is blocked.
 *   - The app never shows a spinner waiting on a request that cannot succeed.
 *   - Closing the browser, the battery dying, or the tab being killed cannot destroy a
 *     record, because it was durable before the user left the screen.
 *
 * Records carry a `clientId` (a UUID generated on the device). The server treats it as an
 * idempotency key, which is what makes replaying a sync batch safe.
 *
 * Records are scoped by `userId` so a shared field phone that two workers log into does
 * not show one worker's patients to the other.
 */

import Dexie, { type Table } from 'dexie';
import type {
  Assessment,
  AssessmentFormInput,
  GlucoseMeasurementType,
  InputMethod,
  Sex,
} from '@/types';
import type {
  DecisionPathStep,
  FeatureAttribution,
  RiskBand,
  RiskReason,
  RiskRecommendation,
  SecondOpinion,
} from '@shared/risk/index.js';

export type SyncState = 'pending' | 'synced' | 'failed';

/** A screening as stored on the device. */
export interface LocalAssessment {
  /** Device-generated UUID. Primary key here and the idempotency key on the server. */
  clientId: string;

  /** Owner, so records do not leak between workers sharing a handset. */
  userId: string;

  patientClientId: string;
  patientName: string;
  patientAge: number;
  patientSex: Sex;
  patientVillage: string;
  patientPhone: string;

  input: AssessmentFormInput;

  /** Scored on-device by the bundled model, so a result exists with no connection. */
  riskBand: RiskBand;
  riskPercent: number;
  probability: number;
  derived: {
    bmi: number;
    bmiCategory: string;
    glucoseCategory: string;
    glucoseMeasurementType: GlucoseMeasurementType;
    diastolicBpCategory: string;
  };
  imputedFields: string[];
  reasons: RiskReason[];
  recommendations: RiskRecommendation[];
  /** The tree's path. This is what produced `riskBand`. */
  decisionPath: DecisionPathStep[];

  /**
   * Neural second opinion and per-feature attributions, also computed on-device.
   *
   * OPTIONAL, and readers must treat them as optional. Two reasons, both real:
   *
   *   1. Records saved by a bundle older than engine 1.1.0 do not have these fields, and
   *      there is no schema version on a stored assessment to migrate against. Dexie does
   *      not validate row shape, so old rows simply come back without them.
   *   2. The engine degrades to a null second opinion rather than failing a screening if
   *      the neural artefact cannot be evaluated.
   *
   * Adding them as optional is what makes this a zero-migration change.
   */
  secondOpinion?: SecondOpinion | null;
  attributions?: FeatureAttribution[];

  capturedAt: string;
  language: 'bn' | 'hi' | 'en';
  inputMethod: InputMethod;

  /** True when the record was created with no connectivity. Shown as a badge. */
  createdOffline: boolean;

  syncState: SyncState;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;

  /** Server's own id, once synced. Needed to book a teleconsult against the record. */
  serverId: string | null;
  serverPatientId: string | null;
}

/** A chatbot question, kept so offline questions still reach the unmatched-question log. */
export interface LocalChatQuestion {
  localId?: number;
  userId: string | null;
  question: string;
  language: string;
  intentId: string;
  matched: boolean;
  askedAt: string;
  answeredOffline: boolean;
  /**
   * 0 or 1, not a boolean: IndexedDB cannot use booleans as index keys, so a boolean here
   * would make the `synced` index silently unusable and the sync query would return
   * nothing. This is a well-known Dexie footgun.
   */
  synced: 0 | 1;
}

/** Small key/value store for sync bookkeeping. */
export interface MetaEntry {
  key: string;
  value: string;
}

class SwasthBharatDb extends Dexie {
  assessments!: Table<LocalAssessment, string>;
  chatQuestions!: Table<LocalChatQuestion, number>;
  meta!: Table<MetaEntry, string>;

  constructor() {
    super('swasthbharat');

    this.version(1).stores({
      // Compound indexes match the two queries that actually run: "my pending records"
      // (the sync flush) and "my recent records newest first" (the home screen).
      assessments: 'clientId, userId, syncState, capturedAt, [userId+syncState], [userId+capturedAt]',
      chatQuestions: '++localId, userId, synced, askedAt',
      meta: 'key',
    });
  }
}

export const db = new SwasthBharatDb();

/* Assessment helpers ------------------------------------------------------- */

export async function saveAssessmentLocally(record: LocalAssessment): Promise<void> {
  // put, not add: re-saving the same clientId (a retry after a crash) must overwrite
  // rather than throw a ConstraintError and lose the record.
  await db.assessments.put(record);
}

export async function getAssessment(clientId: string): Promise<LocalAssessment | undefined> {
  return db.assessments.get(clientId);
}

export async function listRecentAssessments(userId: string, limit = 20): Promise<LocalAssessment[]> {
  const rows = await db.assessments.where('[userId+capturedAt]').between([userId, ''], [userId, '\uffff']).toArray();
  return rows.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)).slice(0, limit);
}

/**
 * Counts for the home screen's "today" and "high risk" cards.
 *
 * Deliberately NOT derived from `listRecentAssessments`, which caps at a small limit for
 * display. A worker who has screened 14 patients today would see the counter freeze at 10
 * if it were sourced from that capped list — this scans the full per-user index instead, so
 * the count is exact regardless of how many records exist.
 */
export async function getHomeStats(
  userId: string,
): Promise<{ todayCount: number; highRiskCount: number }> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startIso = startOfToday.toISOString();

  const rows = await db.assessments
    .where('[userId+capturedAt]')
    .between([userId, startIso], [userId, '\uffff'])
    .toArray();

  return {
    todayCount: rows.length,
    highRiskCount: rows.filter((row) => row.riskBand === 'HIGH').length,
  };
}

/**
 * Rehydrates the local store from the server's copy of this worker's own screenings.
 *
 * ### Why this has to exist
 *
 * Every screen a field worker uses — the home counters, the recent list, the result page —
 * reads from IndexedDB and never from the API, which is what makes them work with no signal.
 * But `clearLocalData` deletes this worker's rows on logout, deliberately, so a shared
 * handset does not show the next worker the previous one's patients.
 *
 * Those two correct decisions combined into a bug: log out, log back in, and the home screen
 * reported "0 screened today" and "No screenings yet" while the Patients tab — which does
 * read the API — still listed everyone. The records were never lost; the device had simply
 * forgotten them and nothing ever asked the server for them back.
 *
 * So the local store is a CACHE of the worker's own records, not the only copy. The server is
 * the record of truth, and this is the download half of the sync that previously only
 * uploaded. It also repairs the same emptiness after cleared browser data or a new device.
 *
 * ### What it will not do
 *
 * It will not touch a record that still has unsent work. A local `pending` or `failed` row is
 * the ONLY copy of that screening, and overwriting it with a server row — which cannot exist
 * yet — would drop a patient's data and silently mark the queue clean. Those clientIds are
 * excluded, so a rehydrate during a half-drained queue is safe.
 *
 * Scoped per user by construction: the caller passes `userId`, every row is stamped with it,
 * and the server has already restricted the response to `createdBy: this worker` for an ASHA
 * role. A worker cannot rehydrate someone else's patients onto their phone.
 *
 * @returns how many rows were written, for logging.
 */
export async function importServerAssessments(
  userId: string,
  records: Assessment[],
): Promise<number> {
  if (records.length === 0) return 0;

  const localRows = await db.assessments
    .where('[userId+capturedAt]')
    .between([userId, ''], [userId, '\uffff'])
    .toArray();

  // Anything not yet accepted by the server must survive untouched. See above.
  const stillUnsent = new Set(
    localRows.filter((row) => row.syncState !== 'synced').map((row) => row.clientId),
  );

  const rows: LocalAssessment[] = [];

  for (const record of records) {
    // A server record with no clientId predates the offline queue and has no local identity
    // to key on. Skipping is correct: inventing one would create a duplicate on next sync.
    if (!record.clientId) continue;
    if (stillUnsent.has(record.clientId)) continue;

    rows.push({
      clientId: record.clientId,
      userId,
      patientClientId: record.patientClientId ?? '',
      patientName: record.patient?.name ?? '',
      /** Falls back to the scored input, which always carries age and sex. */
      patientAge: record.patient?.age ?? record.input.age,
      patientSex: record.patient?.sex ?? record.input.sex,
      patientVillage: record.patient?.village ?? '',
      patientPhone: record.patient?.phone ?? '',

      input: record.input,

      riskBand: record.riskBand,
      riskPercent: record.riskPercent,
      probability: record.probability,
      derived: record.derived,
      imputedFields: record.imputedFields ?? [],
      reasons: record.reasons ?? [],
      recommendations: record.recommendations ?? [],
      decisionPath: record.decisionPath ?? [],

      // Optional on both sides. `?? null` rather than dropping the key, so a rehydrated row
      // and a locally written one have the same shape.
      secondOpinion: record.secondOpinion ?? null,
      attributions: record.attributions ?? [],

      capturedAt: record.capturedAt,
      language: record.language,
      inputMethod: record.inputMethod,
      /** Preserves the "synced from offline" badge across a rehydrate. */
      createdOffline: record.source === 'offline-sync',

      syncState: 'synced',
      attempts: 0,
      lastAttemptAt: record.syncedAt ?? null,
      lastError: null,

      /** Present, so booking a teleconsult works on a rehydrated record too. */
      serverId: record.id,
      serverPatientId: record.patientId ?? null,
    });
  }

  await db.assessments.bulkPut(rows);
  return rows.length;
}

export async function listUnsyncedAssessments(userId: string, limit = 50): Promise<LocalAssessment[]> {
  const pending = await db.assessments.where('[userId+syncState]').equals([userId, 'pending']).toArray();
  const failed = await db.assessments.where('[userId+syncState]').equals([userId, 'failed']).toArray();

  // Oldest first: a queue that drains in capture order is far easier to reason about when
  // a worker is watching the pending count go down.
  return [...pending, ...failed]
    .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    .slice(0, limit);
}

export async function countByState(userId: string): Promise<{ pending: number; failed: number; synced: number }> {
  const [pending, failed, synced] = await Promise.all([
    db.assessments.where('[userId+syncState]').equals([userId, 'pending']).count(),
    db.assessments.where('[userId+syncState]').equals([userId, 'failed']).count(),
    db.assessments.where('[userId+syncState]').equals([userId, 'synced']).count(),
  ]);
  return { pending, failed, synced };
}

export async function markSynced(
  clientId: string,
  serverIds: { assessmentId?: string; patientId?: string } = {},
): Promise<void> {
  await db.assessments.update(clientId, {
    syncState: 'synced',
    lastError: null,
    lastAttemptAt: new Date().toISOString(),
    ...(serverIds.assessmentId ? { serverId: serverIds.assessmentId } : {}),
    ...(serverIds.patientId ? { serverPatientId: serverIds.patientId } : {}),
  });
}

export async function markFailed(clientId: string, error: string): Promise<void> {
  const existing = await db.assessments.get(clientId);
  await db.assessments.update(clientId, {
    syncState: 'failed',
    attempts: (existing?.attempts ?? 0) + 1,
    lastAttemptAt: new Date().toISOString(),
    lastError: error,
  });
}

/** Returns the record to the queue after a network failure (as opposed to a bad record). */
export async function markPendingAgain(clientId: string, error: string): Promise<void> {
  const existing = await db.assessments.get(clientId);
  await db.assessments.update(clientId, {
    syncState: 'pending',
    attempts: (existing?.attempts ?? 0) + 1,
    lastAttemptAt: new Date().toISOString(),
    lastError: error,
  });
}

/* Chat helpers ------------------------------------------------------------- */

export async function saveChatQuestion(entry: Omit<LocalChatQuestion, 'localId'>): Promise<void> {
  await db.chatQuestions.add(entry as LocalChatQuestion);
}

export async function listUnsyncedChatQuestions(limit = 100): Promise<LocalChatQuestion[]> {
  return db.chatQuestions.where('synced').equals(0).limit(limit).toArray();
}

export async function markChatQuestionsSynced(ids: number[]): Promise<void> {
  await db.chatQuestions.where('localId').anyOf(ids).modify({ synced: 1 });
}

/* Meta helpers ------------------------------------------------------------- */

export async function getMeta(key: string): Promise<string | null> {
  const row = await db.meta.get(key);
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}

/**
 * Clears local data. Called on logout, because a field phone is often shared and the next
 * worker must not inherit the previous one's patient records.
 *
 * Refuses to run while records are still unsynced, so logging out cannot silently destroy
 * a day's work. Callers must surface this to the user.
 */
export async function clearLocalData(userId: string): Promise<{ cleared: boolean; unsynced: number }> {
  const { pending, failed } = await countByState(userId);
  const unsynced = pending + failed;
  if (unsynced > 0) return { cleared: false, unsynced };

  await db.assessments.where('userId').equals(userId).delete();
  return { cleared: true, unsynced: 0 };
}
