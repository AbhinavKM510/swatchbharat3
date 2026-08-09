/**
 * Teleconsultation — SIMULATED. Read this before demoing it.
 *
 * ### What is real
 *
 * The booking. It hits `POST /api/teleconsult`, is stored, appears in the PHC doctor's
 * queue, and pushes a live Socket.io notification to the dashboard. The status transitions
 * are persisted. All of that is genuine backend behaviour.
 *
 * ### What is not real
 *
 * The call. There is no WebRTC peer connection, no Twilio, no media server, no TURN relay.
 * The "connecting…" animation is a timer, the call screen is a layout, and the duration
 * counter counts local seconds. `sessionId` is prefixed `sim-` and connects to nothing.
 *
 * ### Why the disclosure is in the UI and not only in the pitch
 *
 * Because a judge will tap through this unattended, and a fake call presented without
 * qualification is the difference between a prototype and a lie. The banner is not
 * dismissible and appears before the button, not after the call.
 *
 * A real implementation needs: a media server (LiveKit/Janus) or provider SDK, TURN servers
 * for villages behind carrier NAT, a doctor availability calendar, and explicit consent
 * capture before any recording.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { TextAreaField } from '@/components/forms';
import { RiskChip } from '@/components/risk';
import { Card, EmptyState, Notice, Spinner } from '@/components/ui';
import { useI18n, type Language } from '@/i18n';
import { api } from '@/lib/api';
import { getAssessment, type LocalAssessment } from '@/lib/db';
import { formatDuration } from '@/lib/format';
import { useToast } from '@/state/ToastContext';

type Phase = 'booking' | 'connecting' | 'in-call' | 'ended';

/** How long the fake "connecting" state lasts. Long enough to read, short enough to demo. */
const CONNECTING_MS = 2600;

export function TeleconsultPage() {
  const { clientId = '' } = useParams();
  const { t, language } = useI18n();
  const { show } = useToast();
  const navigate = useNavigate();

  const [record, setRecord] = useState<LocalAssessment | null>(null);
  const [loading, setLoading] = useState(true);
  const [phase, setPhase] = useState<Phase>('booking');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [muted, setMuted] = useState(false);
  const [teleconsultId, setTeleconsultId] = useState<string | null>(null);

  const timers = useRef<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await getAssessment(clientId);
      if (!cancelled) {
        setRecord(found ?? null);
        setLoading(false);
        setReason(found ? t('teleconsult.reasonPlaceholder') : '');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId, t]);

  // Clear every pending timer on unmount, or the "connecting -> in-call" transition fires
  // into an unmounted component if the user navigates away mid-animation.
  useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id));
      timers.current = [];
    },
    [],
  );

  // Call duration counter. Purely local — there is no call to measure.
  useEffect(() => {
    if (phase !== 'in-call') return;
    const interval = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, [phase]);

  const book = useCallback(async () => {
    if (!record || submitting) return;

    if (!record.serverPatientId && !record.serverId) {
      show(t('teleconsult.offlineBlocked'), 'error');
      return;
    }

    setSubmitting(true);
    try {
      // The patient id comes from the synced record; a queued record has no server id yet,
      // which is why the result page gates this button until sync completes.
      const created = await api.teleconsult.request({
        clientId: `tc_${record.clientId}`,
        patientId: record.serverPatientId ?? '',
        assessmentId: record.serverId,
        reason,
        preferredLanguage: language,
      });

      setTeleconsultId(created.teleconsult.id);
      setPhase('connecting');

      // The simulation. A real client would await an SDP answer here.
      timers.current.push(
        window.setTimeout(() => {
          setPhase('in-call');
          void api.teleconsult
            .setStatus(created.teleconsult.id, 'in-call')
            .catch(() => undefined);
        }, CONNECTING_MS),
      );

      void api.teleconsult.setStatus(created.teleconsult.id, 'connecting').catch(() => undefined);
    } catch {
      show(t('errors.network'), 'error');
    } finally {
      setSubmitting(false);
    }
  }, [language, reason, record, show, submitting, t]);

  const endCall = useCallback(() => {
    setPhase('ended');
    if (teleconsultId) {
      void api.teleconsult
        .setStatus(teleconsultId, 'completed', { durationSeconds: seconds })
        .catch(() => undefined);
    }
  }, [seconds, teleconsultId]);

  if (loading) {
    return (
      <AppShell title={t('teleconsult.title')}>
        <div className="centre-screen">
          <Spinner label={t('common.loading')} />
        </div>
      </AppShell>
    );
  }

  if (!record) {
    return (
      <AppShell title={t('teleconsult.title')}>
        <EmptyState
          icon={'\u2014'}
          title={t('errors.notFound')}
          action={
            <Link className="button" to="/">
              {t('errors.goHome')}
            </Link>
          }
        />
      </AppShell>
    );
  }

  /* The call screen replaces the page chrome so the layout reads as a call. */
  if (phase === 'connecting' || phase === 'in-call') {
    return (
      <AppShell title={t('teleconsult.title')} subtitle={record.patientName} hideNav>
        <div className="stack">
          <Notice tone="warning" title={t('teleconsult.simulatedTitle')}>
            {t('teleconsult.simulatedNotice')}
          </Notice>

          <div className="call-screen">
            <div
              className={`call-avatar${phase === 'connecting' ? ' call-avatar--connecting' : ''}`}
              aria-hidden="true"
            >
              {'\u{1F468}\u200D\u2695\uFE0F'}
            </div>

            {phase === 'connecting' ? (
              <>
                <p style={{ fontSize: 'var(--font-size-lg)', fontWeight: 700 }} role="status">
                  {t('teleconsult.connecting')}
                </p>
                <p className="text-sm" style={{ opacity: 0.85 }}>
                  {t('teleconsult.connectingHint')}
                </p>
              </>
            ) : (
              <>
                <p style={{ fontSize: 'var(--font-size-lg)', fontWeight: 700 }}>
                  {t('teleconsult.callWith')}
                </p>
                <p className="call-timer" role="timer">
                  {formatDuration(seconds)}
                </p>

                <div className="call-controls">
                  <button
                    type="button"
                    className="call-control"
                    onClick={() => setMuted((value) => !value)}
                    aria-label={muted ? t('teleconsult.unmute') : t('teleconsult.mute')}
                    aria-pressed={muted}
                  >
                    <span aria-hidden="true">{muted ? '\u{1F507}' : '\u{1F508}'}</span>
                  </button>

                  <button
                    type="button"
                    className="call-control call-control--end"
                    onClick={endCall}
                    aria-label={t('teleconsult.endCall')}
                  >
                    <span aria-hidden="true">{'\u2715'}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </AppShell>
    );
  }

  if (phase === 'ended') {
    return (
      <AppShell title={t('teleconsult.title')} subtitle={record.patientName}>
        <div className="stack">
          <Card>
            <div className="empty-state">
              <span className="empty-state__icon" aria-hidden="true">
                {'\u2713'}
              </span>
              <p style={{ fontWeight: 700, fontSize: 'var(--font-size-lg)' }}>{t('teleconsult.ended')}</p>
              <p className="text-sm">{t('teleconsult.duration', { duration: formatDuration(seconds) })}</p>
            </div>
          </Card>

          <Notice tone="warning">{t('teleconsult.simulatedNotice')}</Notice>

          <button type="button" className="button button--block" onClick={() => navigate('/')}>
            {t('result.backHome')}
          </button>
        </div>
      </AppShell>
    );
  }

  /* Booking form */
  return (
    <AppShell title={t('teleconsult.title')} subtitle={record.patientName}>
      <div className="stack">
        {/* Before the button, not after. */}
        <Notice tone="warning" title={t('teleconsult.simulatedTitle')}>
          {t('teleconsult.simulatedNotice')}
        </Notice>

        <Card title={t('teleconsult.bookingFor', { name: record.patientName })}>
          <div className="stack">
            <div className="row row--wrap">
              <RiskChip band={record.riskBand} percent={record.riskPercent} />
              <span className="text-sm muted">
                {record.patientAge} {t('common.years')}
                {record.patientVillage ? ` \u00b7 ${record.patientVillage}` : ''}
              </span>
            </div>

            <TextAreaField
              label={t('teleconsult.reason')}
              value={reason}
              onChange={setReason}
              placeholder={t('teleconsult.reasonPlaceholder')}
            />

            <div className="field">
              <span className="field__label">{t('teleconsult.preferredLanguage')}</span>
              <p className="field__hint">{(language as Language).toUpperCase()}</p>
            </div>

            <button type="button" className="button button--hero button--block" onClick={book} disabled={submitting}>
              {submitting ? t('teleconsult.booking') : t('teleconsult.book')}
            </button>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
