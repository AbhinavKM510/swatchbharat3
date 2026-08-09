/**
 * PHC doctor dashboard.
 *
 * ### The live-alert path
 *
 * The queue refreshes itself on a short interval (`POLL_INTERVAL_MS`) and diffs the result
 * against what is already on screen. A case that was not there before is treated as an
 * arrival: it gets the highlight animation and, when it is HIGH risk, a toast.
 *
 * This used to be a Socket.io push, which was instant. It is polling now because the API is
 * deployed as serverless functions, and a serverless function cannot hold a WebSocket open —
 * it exists per request and is frozen between them. The backend's emit helpers are still
 * called and simply no-op (see `backend/src/realtime/io.js`), so nothing else had to change,
 * and the whole path returns to being a real push the moment the API runs as a long-lived
 * process again.
 *
 * The observable difference is latency: a case appears within a few seconds rather than
 * immediately. Everything else about this screen behaves the same.
 *
 * Duplicate protection matters more than it looks: a case can be present in the initial
 * fetch AND in the first poll, so arrivals are tracked by id in `seenAlertIdsRef` and only
 * ever announced once.
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
import { useAuth } from '@/state/AuthContext';
import { useToast } from '@/state/ToastContext';
import type { Assessment, DashboardSummary, ReviewStatus } from '@/types';

type StatusFilter = 'open' | 'all';
type BandFilter = 'HIGH' | 'HIGH,MODERATE';

/**
 * Reasons shown per queue card.
 *
 * Held at 3 so a card stays scannable in a worklist — a doctor triaging twenty cases needs
 * the headline findings, and the full list is one tap away in the expanded view.
 */
const QUEUE_CARD_REASON_COUNT = 3;

/**
 * How often the queue re-checks the server for new cases.
 *
 * 4s is a deliberate compromise: fast enough that a case submitted during a live demo shows
 * up while everyone is still looking at the screen, slow enough that a dashboard left open
 * for an hour does not hammer the API (900 requests/hour on serverless, well within limits).
 */
const POLL_INTERVAL_MS = 4000;

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

  /**
   * Read inside the poll loop, which must not be torn down and restarted every time a
   * filter changes — that would reset the interval and stall the next refresh.
   */
  const filterRef = useRef({ band, status });
  filterRef.current = { band, status };

  /**
   * Every assessment id this session has already seen.
   *
   * Primed by the initial fetch so the first poll does not announce the entire existing
   * backlog as if it had just arrived. A case is only ever toasted once, even though it will
   * appear in every subsequent poll response.
   */
  const seenAlertIdsRef = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [flagged, stats] = await Promise.all([
        api.dashboard.flagged({ band, status, limit: 100 }),
        api.dashboard.summary(),
      ]);
      // Everything already on the server at first paint is history, not an arrival.
      for (const item of flagged.items) seenAlertIdsRef.current.add(item.id);
      setItems(flagged.items);
      setSummary(stats);
      setLive(true);
    } catch {
      // NetworkFirst caching in the service worker means a dashboard opened on a dead
      // connection still shows the last known queue rather than an empty screen.
      setLive(false);
      show(t('errors.network'), 'error');
    } finally {
      setLoading(false);
    }
  }, [band, status, show, t]);

  useEffect(() => {
    void load();
  }, [load]);

  /* Near-real-time queue refresh ------------------------------------------ */
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const { band: currentBand, status: currentStatus } = filterRef.current;
        const [flagged, stats] = await Promise.all([
          api.dashboard.flagged({ band: currentBand, status: currentStatus, limit: 100 }),
          api.dashboard.summary(),
        ]);
        if (cancelled) return;

        setLive(true);
        setSummary(stats);

        // Anything the server has that this session has never seen is an arrival.
        const arrivals = flagged.items.filter((item) => !seenAlertIdsRef.current.has(item.id));
        for (const item of arrivals) seenAlertIdsRef.current.add(item.id);

        // Replace wholesale rather than merging: the server response IS the queue, already
        // filtered and sorted (risk band, then oldest-first). Merging would let a case a
        // doctor triaged on another device linger here.
        setItems(flagged.items);

        if (arrivals.length > 0) {
          setArrivedIds((current) => {
            const next = new Set(current);
            for (const item of arrivals) next.add(item.id);
            return next;
          });
        }

        // Only HIGH gets a toast. A MODERATE case appearing in the combined view is
        // information; interrupting a doctor for it would train them to dismiss alerts.
        for (const item of arrivals) {
          if (item.riskBand !== 'HIGH') continue;
          show(
            `${t('dashboard.newAlertTitle')}: ${t('dashboard.newAlertBody', {
              name: item.patient?.name ?? '\u2014',
              age: item.patient?.age ?? '\u2014',
              village: item.patient?.village || '\u2014',
            })}`,
            'error',
            7000,
          );
        }
      } catch {
        // A failed poll is normal on a flaky connection. Drop the live indicator and keep
        // the last known queue on screen rather than blanking it.
        if (!cancelled) setLive(false);
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };

    timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
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
          a reason to look at them sooner.
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
