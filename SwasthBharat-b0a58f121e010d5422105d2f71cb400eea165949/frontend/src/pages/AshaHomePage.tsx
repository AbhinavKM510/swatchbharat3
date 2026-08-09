/**
 * The field worker's home screen.
 *
 * One job: get her into a new screening in a single tap. Everything else on the page is
 * secondary, which is why "Start a new screening" is a 72px-tall hero button and nothing
 * else competes with it.
 *
 * The counters and recent list read from IndexedDB, not the API, so this screen is fully
 * functional offline. It shows her own work — which is exactly what she needs to know
 * whether today's visits have been recorded.
 *
 * That local-only read is why the sync manager now downloads past screenings back into
 * IndexedDB after login (see `importServerAssessments` in lib/db.ts). Logout wipes the local
 * store for shared-handset privacy, so without the download this screen reported "0 screened
 * today" after a re-login while the records sat safely on the server.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { RiskChip } from '@/components/risk';
import { Card, EmptyState, Notice, StatCard, Tag } from '@/components/ui';
import { useI18n } from '@/i18n';
import { countByState, getHomeStats, listRecentAssessments, type LocalAssessment } from '@/lib/db';
import { formatRelativeTime } from '@/lib/format';
import { useAuth } from '@/state/AuthContext';
import { useSyncState } from '@/state/useSyncState';

export function AshaHomePage() {
  const { t, language } = useI18n();
  const { user, restoredOffline } = useAuth();
  const sync = useSyncState();

  const [recent, setRecent] = useState<LocalAssessment[]>([]);
  const [counts, setCounts] = useState({ pending: 0, failed: 0, synced: 0 });
  // Computed over the FULL per-user record set, not the capped "recent" list below — a
  // worker who has screened more than 10 patients today must still see an accurate count.
  const [stats, setStats] = useState({ todayCount: 0, highRiskCount: 0 });

  // Refreshes when the queue changes, so the counters move as records drain.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    void (async () => {
      const [records, stateCounts, homeStats] = await Promise.all([
        listRecentAssessments(user.id, 10),
        countByState(user.id),
        getHomeStats(user.id),
      ]);
      if (cancelled) return;
      setRecent(records);
      setCounts(stateCounts);
      setStats(homeStats);
    })();

    return () => {
      cancelled = true;
    };
    // `lastRestoredAt` is in here so the counters fill in when past screenings are pulled
    // back down after a fresh login. Without it this effect reads an empty table once and
    // shows 0 until the next navigation.
  }, [user, sync.pending, sync.failed, sync.lastSyncedAt, sync.lastRestoredAt]);

  const { todayCount, highRiskCount } = stats;

  return (
    <AppShell title={t('home.greeting', { name: user?.name ?? '' })} subtitle={user?.phc?.name}>
      <div className="stack">
        {restoredOffline ? <Notice tone="offline">{t('connection.offlineBanner')}</Notice> : null}

        {/* The primary action, sized so it cannot be missed or mis-tapped. */}
        <Link to="/screening" className="button button--hero button--block">
          <span aria-hidden="true" style={{ fontSize: '1.5em' }}>
            +
          </span>
          {t('home.startScreening')}
        </Link>
        <p className="faint" style={{ textAlign: 'center', marginTop: 'calc(-1 * var(--space-2))' }}>
          {t('home.startScreeningHint')}
        </p>

        <div className="stat-grid">
          <StatCard value={todayCount} label={t('home.todayCount')} />
          <StatCard value={highRiskCount} label={t('home.highRiskCount')} alert={highRiskCount > 0} />
          <StatCard
            value={counts.pending + counts.failed}
            label={t('home.pendingSync')}
            alert={counts.failed > 0}
          />
        </div>

        {counts.failed > 0 ? (
          <Notice tone="warning">{t('connection.syncFailedCount', { count: counts.failed })}</Notice>
        ) : null}

        <Card title={t('home.recentTitle')}>
          {recent.length === 0 ? (
            <EmptyState icon={'\u002b'} title={t('home.recentEmpty')} />
          ) : (
            <div className="stack stack--tight">
              {recent.map((record) => (
                <Link
                  key={record.clientId}
                  to={`/result/${record.clientId}`}
                  className={`patient-card patient-card--${record.riskBand}`}
                  style={{ textDecoration: 'none', color: 'inherit' }}
                >
                  <div className="row row--between">
                    <span className="patient-card__name">{record.patientName}</span>
                    <RiskChip band={record.riskBand} percent={record.riskPercent} />
                  </div>

                  <div className="row row--wrap text-sm muted">
                    <span>
                      {record.patientAge} {t('common.years')}
                    </span>
                    {record.patientVillage ? <span>&middot; {record.patientVillage}</span> : null}
                    <span>&middot; {formatRelativeTime(record.capturedAt, language)}</span>
                  </div>

                  <div className="tag-row">
                    {record.syncState === 'pending' ? (
                      <Tag tone="offline" icon={'\u2601'}>
                        {t('connection.pendingOne')}
                      </Tag>
                    ) : null}
                    {record.syncState === 'failed' ? (
                      <Tag tone="warning" icon={'\u26a0'}>
                        {t('connection.syncFailed')}
                      </Tag>
                    ) : null}
                    {record.createdOffline ? <Tag>{t('dashboard.syncedFromOffline')}</Tag> : null}
                    {record.inputMethod !== 'typed' ? (
                      <Tag icon={'\u{1F3A4}'}>{t('dashboard.voiceEntry')}</Tag>
                    ) : null}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </Card>

        <div className="stack stack--tight">
          <Link className="button button--secondary button--block" to="/help">
            {t('home.askHealthHelp')}
          </Link>
          <Link className="button button--ghost button--block" to="/model">
            {t('nav.modelCard')}
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
