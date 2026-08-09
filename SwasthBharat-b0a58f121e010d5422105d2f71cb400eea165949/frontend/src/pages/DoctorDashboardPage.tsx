/**
 * PHC doctor dashboard.
 *
 * ### The live-alert path
 *
 * Socket.io pushes `assessment:high-risk` into a room scoped to this doctor's PHC. The
 * handler prepends the case to the queue in local state — it does NOT refetch. A refetch
 * would work but would take a round trip and lose the arriving card's animation, and the
 * point of this screen is that the case appears while you are looking at it.
 *
 * Duplicate protection matters more than it looks: the same assessment can arrive both from
 * the socket and from the initial fetch (if it was created between the two), so inserts are
 * de-duplicated by id.
 *
 * ### Why the queue is ordered oldest-first within a risk band
 *
 * A high-risk patient screened three days ago and never contacted is a worse problem than
 * one screened an hour ago. Newest-first would bury exactly the people who have been waiting
 * longest, which is the opposite of what a worklist should do.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { ReasonList, RiskChip } from '@/components/risk';
import { Card, Collapsible, EmptyState, Notice, Spinner, StatCard, Tag } from '@/components/ui';
import { useI18n } from '@/i18n';
// No Firebase SDK here: pushMessaging imports it dynamically so it stays out of the
// offline precache. See lib/pushMessaging.ts.
import {
  disablePushAlerts,
  enablePushAlerts,
  isPushEnabled,
  pushSupport,
  refreshPushRegistration,
} from '@/lib/pushMessaging';
import { api } from '@/lib/api';
import { formatRelativeTime } from '@/lib/format';
import { connectSocket, REALTIME_EVENTS } from '@/lib/socket';
import { useAuth } from '@/state/AuthContext';
import { useToast } from '@/state/ToastContext';
import type { Assessment, DashboardSummary, HighRiskAlert, ReviewStatus } from '@/types';

type StatusFilter = 'open' | 'all';
type BandFilter = 'HIGH' | 'HIGH,MODERATE';

/**
 * A socket-delivered alert only ever carries the top 3 reasons (see `ALERT_REASON_COUNT`
 * in the backend). A fetched record carries the full list, which can be longer. Capping
 * both to the same count keeps a socket-delivered card and a refresh-delivered card
 * identical for the same case, rather than one looking more thorough than the other.
 */
const QUEUE_CARD_REASON_COUNT = 3;

export function DoctorDashboardPage() {
  const { t, language } = useI18n();
  const { user } = useAuth();
  const { show } = useToast();

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [items, setItems] = useState<Assessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const [band, setBand] = useState<BandFilter>('HIGH');
  const [status, setStatus] = useState<StatusFilter>('open');
  const [arrivedIds, setArrivedIds] = useState<Set<string>>(new Set());

  /**
   * Background push. `pushSupported` is computed once: it depends on build-time config and
   * browser capabilities, neither of which changes while the page is open.
   */
  const pushSupported = useRef(pushSupport().supported).current;
  const [pushOn, setPushOn] = useState(() => isPushEnabled());
  const [pushBusy, setPushBusy] = useState(false);

  /**
   * Flips background notifications on or off.
   *
   * `enablePushAlerts` does the permission prompt, the token fetch and the server
   * registration, and only reports success when all three worked — so the toggle reflects
   * whether alerts will actually arrive, rather than whether the click was registered. On
   * failure the state is left off and the reason is surfaced, because "notifications are on"
   * when they are not is exactly the promise this feature must not break.
   */
  const togglePush = useCallback(async () => {
    setPushBusy(true);
    try {
      if (pushOn) {
        await disablePushAlerts();
        setPushOn(false);
        show(t('dashboard.pushDisabled'), 'info');
        return;
      }

      const result = await enablePushAlerts();
      if (result.ok) {
        setPushOn(true);
        show(t('dashboard.pushEnabled'), 'success');
        return;
      }

      setPushOn(false);
      show(
        result.reason === 'denied'
          ? t('dashboard.pushDenied')
          : result.reason === 'server'
            ? t('dashboard.pushUnavailable')
            : result.reason === 'dismissed'
              ? t('dashboard.pushDismissed')
              : t('dashboard.pushFailed'),
        // A dismissed prompt is not an error, just an unfinished choice. The other three
        // are genuine failures and should read as such.
        result.reason === 'dismissed' ? 'info' : 'error',
      );
    } finally {
      setPushBusy(false);
    }
  }, [pushOn, show, t]);

  /**
   * Re-registers the device token on mount when the doctor has already opted in.
   *
   * FCM rotates tokens, so one obtained days ago may no longer be what this browser would
   * present — and the server would be pushing into a void with no error anywhere. Cheap: it
   * returns immediately unless the preference is on and permission is still granted.
   */
  useEffect(() => {
    void refreshPushRegistration();
  }, []);

  /** Read inside socket handlers, which must not re-subscribe when filters change. */
  const filterRef = useRef({ band, status });
  filterRef.current = { band, status };

  /**
   * Assessment ids already handled by a socket alert this session.
   *
   * A HIGH case is emitted to both the PHC room and the district room, and a doctor's
   * socket is a member of both, so the same alert arrives twice. Checked synchronously
   * (unlike a state setter's updater, which is not guaranteed to run before the next line)
   * so the toast and counters only fire once per case.
   */
  const seenAlertIdsRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [flagged, stats] = await Promise.all([
        api.dashboard.flagged({ band, status, limit: 100 }),
        api.dashboard.summary(),
      ]);
      setItems(flagged.items);
      setSummary(stats);
    } catch {
      // NetworkFirst caching in the service worker means a dashboard opened on a dead
      // connection still shows the last known queue rather than an empty screen.
      show(t('errors.network'), 'error');
    } finally {
      setLoading(false);
    }
  }, [band, status, show, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /* Realtime -------------------------------------------------------------- */
  useEffect(() => {
    const socket = connectSocket();

    const onReady = () => setLive(true);
    const onDisconnect = () => setLive(false);

    const onHighRisk = (alert: HighRiskAlert) => {
      // Respect the current filter: an arriving MODERATE case must not appear in a
      // HIGH-only list, or the list stops matching its own heading.
      if (filterRef.current.band === 'HIGH' && alert.riskBand !== 'HIGH') return;

      // The same alert can legitimately arrive twice: every socket joins both a PHC room
      // and a district room, and a HIGH case is emitted to both (see
      // `assessmentService.js`). A doctor is a member of both, so their single socket
      // receives the event twice. Checked here, synchronously, rather than inside the
      // `setItems` updater below — a state updater is not guaranteed to run before the
      // toast/counter code that follows it.
      if (seenAlertIdsRef.current.has(alert.assessmentId)) return;
      seenAlertIdsRef.current.add(alert.assessmentId);

      setItems((current) => {
        if (current.some((item) => item.id === alert.assessmentId)) return current;

        // Build a minimally-populated Assessment from the alert payload. The alert carries
        // everything the card renders; a full record is only needed if the doctor opens it.
        const optimistic = {
          id: alert.assessmentId,
          clientId: alert.clientId,
          patientId: alert.patient.id,
          patientClientId: '',
          patient: {
            id: alert.patient.id,
            clientId: '',
            name: alert.patient.name,
            age: alert.patient.age,
            sex: alert.patient.sex,
            phone: '',
            village: alert.patient.village,
            phcId: alert.phcId,
            district: alert.district,
            capturedAt: alert.capturedAt,
            createdAt: alert.capturedAt,
          },
          phcId: alert.phcId,
          district: alert.district,
          createdBy: { id: alert.reportedBy.id, name: alert.reportedBy.name, phone: '' },
          riskBand: alert.riskBand,
          riskPercent: alert.riskPercent,
          probability: alert.riskPercent / 100,
          derived: alert.derived,
          imputedFields: [],
          reasons: alert.topReasons,
          recommendations: [],
          decisionPath: [],
          // Carried on the alert specifically so this optimistic card renders the same
          // tags as one that arrived from a fetch. `attributions` is intentionally left
          // empty: the alert does not carry it and the queue card does not show it.
          secondOpinion: alert.secondOpinion ?? null,
          modelDisagreement: alert.modelDisagreement ?? false,
          attributions: [],
          capturedAt: alert.capturedAt,
          syncedAt: alert.syncedAt,
          source: alert.source,
          inputMethod: alert.inputMethod,
          language: 'bn',
          deviceRiskBand: null,
          bandMismatch: alert.bandMismatch,
          reviewStatus: alert.reviewStatus,
          reviewedAt: null,
          reviewNote: '',
          createdAt: alert.syncedAt,
        } as unknown as Assessment;

        return [optimistic, ...current];
      });

      setArrivedIds((current) => new Set(current).add(alert.assessmentId));

      show(
        `${t('dashboard.newAlertTitle')}: ${t('dashboard.newAlertBody', {
          name: alert.patient.name,
          age: alert.patient.age,
          village: alert.patient.village || '\u2014',
        })}`,
        'error',
        7000,
      );

      // Keep the counters honest without a full reload.
      setSummary((current) =>
        current
          ? {
              ...current,
              totals: { ...current.totals, assessments: current.totals.assessments + 1 },
              byBand: { ...current.byBand, [alert.riskBand]: (current.byBand[alert.riskBand] ?? 0) + 1 },
              queue: { openHighRisk: current.queue.openHighRisk + (alert.riskBand === 'HIGH' ? 1 : 0) },
            }
          : current,
      );
    };

    const onReviewed = (payload: { assessmentId: string; reviewStatus: ReviewStatus }) => {
      // Another doctor triaged this case. Reflect it so two people do not both call the
      // same patient.
      setItems((current) =>
        current.map((item) =>
          item.id === payload.assessmentId ? { ...item, reviewStatus: payload.reviewStatus } : item,
        ),
      );
    };

    socket.on(REALTIME_EVENTS.CONNECTED, onReady);
    socket.on('disconnect', onDisconnect);
    socket.on(REALTIME_EVENTS.HIGH_RISK_ALERT, onHighRisk);
    socket.on(REALTIME_EVENTS.ASSESSMENT_REVIEWED, onReviewed);

    return () => {
      socket.off(REALTIME_EVENTS.CONNECTED, onReady);
      socket.off('disconnect', onDisconnect);
      socket.off(REALTIME_EVENTS.HIGH_RISK_ALERT, onHighRisk);
      socket.off(REALTIME_EVENTS.ASSESSMENT_REVIEWED, onReviewed);
      // Left connected on unmount: the doctor may switch tabs within the app and should
      // keep receiving alerts. The socket is torn down on logout.
    };
  }, [show, t]);

  const triage = async (assessment: Assessment, next: ReviewStatus, note: string) => {
    try {
      const { assessment: updated } = await api.assessments.review(assessment.id, next, note);
      setItems((current) =>
        filterRef.current.status === 'open' && (next === 'consulted' || next === 'closed')
          ? current.filter((item) => item.id !== updated.id)
          : current.map((item) => (item.id === updated.id ? updated : item)),
      );
      show(t('common.done'), 'success');
    } catch {
      show(t('errors.generic'), 'error');
    }
  };

  return (
    <AppShell title={t('dashboard.title')} subtitle={user?.phc?.name} wide>
      <div className="stack">
        <div className="row row--wrap">
          <span className="row" style={{ gap: 'var(--space-2)' }}>
            <span className={`status-dot${live ? ' status-dot--live' : ''}`} aria-hidden="true" />
            <span className="text-sm" style={{ fontWeight: 600 }}>
              {live ? t('connection.liveConnected') : t('connection.liveDisconnected')}
            </span>
          </span>
          {/*
            Background notifications, for when this tab is CLOSED. The live indicator to the
            left only means anything while it is open.

            Opt-in for the same reason as the sound, plus a hard constraint: browsers require
            Notification.requestPermission() to come from a user gesture, and asking on page
            load gets the prompt dismissed or blocked permanently — which the user then
            cannot undo without digging through site settings.
          */}
          {pushSupported ? (
            <button
              type="button"
              className="button button--small button--ghost"
              aria-pressed={pushOn}
              disabled={pushBusy}
              onClick={() => void togglePush()}
            >
              <span aria-hidden="true">{pushOn ? '\u{1F4F2}' : '\u{1F4F5}'}</span>{' '}
              {pushBusy ? t('common.loading') : t('dashboard.pushAlerts')}
            </button>
          ) : null}

          <button type="button" className="button button--small button--ghost" onClick={() => void load()}>
            {t('common.refresh')}
          </button>
        </div>

        {summary ? (
          <div className="stat-grid">
            <StatCard
              value={summary.queue.openHighRisk}
              label={t('dashboard.cards.openHighRisk')}
              alert={summary.queue.openHighRisk > 0}
            />
            <StatCard value={summary.totals.today} label={t('dashboard.cards.today')} />
            <StatCard value={summary.totals.assessments} label={t('dashboard.cards.totalAssessments')} />
            <StatCard value={summary.totals.patients} label={t('dashboard.cards.patients')} />
          </div>
        ) : null}

        {summary && summary.dataQuality.bandMismatches > 0 ? (
          <Notice tone="warning">
            {t('dashboard.bandMismatches')}: {summary.dataQuality.bandMismatches}
          </Notice>
        ) : null}

        {/*
          Tone "info", not "warning", and that distinction is the point. The notice above it
          reports a real fault (a device running a stale model). This one reports cases the
          two models scored differently, which means those patients sit near a cut-off —
          a shortlist, not a defect. Styling them the same would teach the doctor to ignore
          both.
        */}
        {summary && (summary.dataQuality.modelDisagreements ?? 0) > 0 ? (
          <Notice tone="info" title={t('dashboard.modelDisagreements')}>
            {summary.dataQuality.modelDisagreements} &middot; {t('dashboard.modelDisagreementsHint')}
          </Notice>
        ) : null}

        <Card title={t('dashboard.queueTitle')} hint={t('dashboard.queueHint')}>
          <div className="stack">
            <div className="row row--wrap">
              <div className="choice-group" style={{ flex: '1 1 auto' }}>
                <button
                  type="button"
                  className="choice"
                  aria-pressed={band === 'HIGH'}
                  onClick={() => setBand('HIGH')}
                >
                  {t('result.band.HIGH')}
                </button>
                <button
                  type="button"
                  className="choice"
                  aria-pressed={band === 'HIGH,MODERATE'}
                  onClick={() => setBand('HIGH,MODERATE')}
                >
                  {`${t('result.band.HIGH')} + ${t('result.band.MODERATE')}`}
                </button>
              </div>

              <div className="choice-group" style={{ flex: '1 1 auto' }}>
                <button
                  type="button"
                  className="choice"
                  aria-pressed={status === 'open'}
                  onClick={() => setStatus('open')}
                >
                  {t('dashboard.statusOpen')}
                </button>
                <button
                  type="button"
                  className="choice"
                  aria-pressed={status === 'all'}
                  onClick={() => setStatus('all')}
                >
                  {t('dashboard.statusAll')}
                </button>
              </div>
            </div>

            {loading ? (
              <div className="centre-screen" style={{ minHeight: 160 }}>
                <Spinner label={t('common.loading')} />
              </div>
            ) : items.length === 0 ? (
              <EmptyState icon={'\u2713'} title={t('dashboard.queueEmpty')} />
            ) : (
              <div className="stack stack--tight">
                {items.map((item) => (
                  <QueueCard
                    key={item.id}
                    assessment={item}
                    isNew={arrivedIds.has(item.id)}
                    language={language}
                    onTriage={triage}
                  />
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}

function QueueCard({
  assessment,
  isNew,
  language,
  onTriage,
}: {
  assessment: Assessment;
  isNew: boolean;
  language: ReturnType<typeof useI18n>['language'];
  onTriage: (assessment: Assessment, next: ReviewStatus, note: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState(assessment.reviewNote ?? '');
  const [busy, setBusy] = useState(false);

  const act = async (next: ReviewStatus) => {
    setBusy(true);
    await onTriage(assessment, next, note);
    setBusy(false);
  };

  return (
    <article
      className={`patient-card patient-card--${assessment.riskBand}${isNew ? ' patient-card--new' : ''}`}
    >
      <div className="row row--between row--wrap">
        <span className="patient-card__name">{assessment.patient?.name ?? '\u2014'}</span>
        <RiskChip band={assessment.riskBand} percent={assessment.riskPercent} />
      </div>

      <div className="row row--wrap text-sm muted">
        <span>
          {assessment.patient?.age} {t('common.years')}
        </span>
        {assessment.patient?.village ? <span>&middot; {assessment.patient.village}</span> : null}
        <span>&middot; {t('dashboard.capturedAt', { time: formatRelativeTime(assessment.capturedAt, language) })}</span>
      </div>

      <div className="tag-row">
        <Tag>{t(`dashboard.status.${assessment.reviewStatus}`)}</Tag>
        {assessment.createdBy ? (
          <Tag>{t('dashboard.reportedBy', { name: assessment.createdBy.name })}</Tag>
        ) : null}
        {assessment.source === 'offline-sync' ? (
          <Tag tone="offline" icon={'\u2601'}>
            {t('dashboard.syncedFromOffline')}
          </Tag>
        ) : null}
        {assessment.inputMethod !== 'typed' ? (
          <Tag icon={'\u{1F3A4}'}>{t('dashboard.voiceEntry')}</Tag>
        ) : null}
        {assessment.bandMismatch ? (
          <Tag tone="warning" icon={'\u26a0'}>
            {t('dashboard.bandMismatch')}
          </Tag>
        ) : null}
        {/*
          The two models disagreed on this patient's band. Not an error and deliberately
          not styled as one — it means the patient sits near a decision boundary, which is
          a reason to look at them sooner. The alert payload carries this field too, so a
          case that arrives live over the socket shows the same tag as a fetched one.
        */}
        {assessment.modelDisagreement && assessment.secondOpinion ? (
          <Tag icon={'\u2696'}>
            {t('dashboard.modelDisagreement', {
              band: t(`result.band.${assessment.secondOpinion.riskBand}`),
            })}
          </Tag>
        ) : null}
      </div>

      {assessment.reasons.length > 0 ? (
        <Collapsible summary={t('result.whyTitle')}>
          <ReasonList reasons={assessment.reasons.slice(0, QUEUE_CARD_REASON_COUNT)} />
        </Collapsible>
      ) : null}

      <div className="stack stack--tight">
        <label className="sr-only" htmlFor={`note-${assessment.id}`}>
          {t('dashboard.reviewNote')}
        </label>
        <input
          id={`note-${assessment.id}`}
          className="input"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t('dashboard.reviewNotePlaceholder')}
          maxLength={500}
        />

        <div className="row row--wrap">
          {assessment.reviewStatus === 'pending' ? (
            <button
              type="button"
              className="button button--small"
              disabled={busy}
              onClick={() => void act('acknowledged')}
            >
              {t('dashboard.markAcknowledged')}
            </button>
          ) : null}
          <button
            type="button"
            className="button button--small button--secondary"
            disabled={busy}
            onClick={() => void act('consulted')}
          >
            {t('dashboard.markConsulted')}
          </button>
          <button
            type="button"
            className="button button--small button--ghost"
            disabled={busy}
            onClick={() => void act('closed')}
          >
            {t('dashboard.markClosed')}
          </button>
        </div>
      </div>
    </article>
  );
}
