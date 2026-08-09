/**
 * Application chrome: header, connection strip, bottom navigation.
 *
 * The connection strip is the most important non-obvious piece. In an offline-first app the
 * user must always be able to answer two questions without thinking:
 *
 *   1. Is my work saved? (always yes — it is written to IndexedDB before anything else)
 *   2. Has it reached the health centre yet?
 *
 * Hiding sync state would make the app feel unreliable precisely when it is behaving
 * correctly. So the strip is permanent: it shows online/offline, the number of records still
 * queued, and a manual "Sync now" that works even when `navigator.onLine` claims otherwise.
 */

import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { LogoutButton } from '@/components/LogoutButton';
import { Spinner } from '@/components/ui';
import { useI18n } from '@/i18n';
import { formatRelativeTime } from '@/lib/format';
import { useAuth } from '@/state/AuthContext';
import { syncManager, useSyncState } from '@/state/useSyncState';

interface NavItem {
  to: string;
  labelKey: 'nav.home' | 'nav.newScreening' | 'nav.patients' | 'nav.chatbot' | 'nav.dashboard' | 'nav.trends';
  icon: string;
}

const NAV_BY_ROLE: Record<string, NavItem[]> = {
  asha: [
    { to: '/', labelKey: 'nav.home', icon: '\u2302' },
    { to: '/screening', labelKey: 'nav.newScreening', icon: '\u002b' },
    { to: '/patients', labelKey: 'nav.patients', icon: '\u2637' },
    { to: '/help', labelKey: 'nav.chatbot', icon: '\u003f' },
  ],
  doctor: [
    { to: '/dashboard', labelKey: 'nav.dashboard', icon: '\u2637' },
    { to: '/patients', labelKey: 'nav.patients', icon: '\u2318' },
    { to: '/trends', labelKey: 'nav.trends', icon: '\u2191' },
    { to: '/help', labelKey: 'nav.chatbot', icon: '\u003f' },
  ],
  officer: [
    { to: '/trends', labelKey: 'nav.trends', icon: '\u2191' },
    { to: '/dashboard', labelKey: 'nav.dashboard', icon: '\u2637' },
    { to: '/help', labelKey: 'nav.chatbot', icon: '\u003f' },
  ],
};

function ConnectionStrip() {
  const { t, language } = useI18n();
  const sync = useSyncState();

  const queued = sync.pending + sync.failed;

  /**
   * The just-synced confirmation outranks every other state for a few seconds.
   *
   * This is the demo's closing moment — the queue draining by itself after the network
   * comes back. A counter quietly ticking to zero is too subtle to read from across a
   * room, so the whole strip turns green and says how many records went out.
   */
  const justSynced = sync.recentlySynced !== null && !sync.syncing;

  const tone = justSynced
    ? 'connection-strip--synced'
    : !sync.online
      ? 'connection-strip--offline'
      : sync.syncing
        ? 'connection-strip--syncing'
        : '';

  return (
    <div className={`connection-strip ${tone}`.trim()} role="status" aria-live="polite">
      <span
        className={`status-dot ${sync.online ? 'status-dot--online' : 'status-dot--offline'}`}
        aria-hidden="true"
      />

      <span>{sync.online ? t('connection.online') : t('connection.offline')}</span>

      {justSynced ? (
        <span style={{ fontWeight: 700 }}>
          <span aria-hidden="true">{'\u2713 '}</span>
          {t('connection.syncedCount', { count: sync.recentlySynced?.created ?? 0 })}
        </span>
      ) : sync.syncing ? (
        <span className="row" style={{ gap: 'var(--space-2)' }}>
          <Spinner />
          {t('connection.syncing')}
        </span>
      ) : queued > 0 ? (
        <span>{queued === 1 ? t('connection.pendingOne') : t('connection.pending', { count: queued })}</span>
      ) : (
        <span className="muted">
          {sync.lastSyncedAt
            ? t('connection.lastSynced', { time: formatRelativeTime(sync.lastSyncedAt, language) })
            : t('connection.allSynced')}
        </span>
      )}

      {queued > 0 && !sync.syncing ? (
        <button
          type="button"
          className="button button--small button--secondary"
          style={{ marginLeft: 'auto' }}
          // force: navigator.onLine is unreliable on rural networks, and a deliberate tap
          // is better evidence of connectivity than the browser's guess.
          onClick={() => void syncManager.flush({ force: true })}
        >
          {t('connection.syncNow')}
        </button>
      ) : null}
    </div>
  );
}

function BottomNav() {
  const { t } = useI18n();
  const { user } = useAuth();

  // Hidden for anonymous visitors: /model renders without a session, and navigation aimed
  // at a role nobody holds is worse than no navigation at all.
  if (!user) return null;

  const items = NAV_BY_ROLE[user.role] ?? NAV_BY_ROLE.asha;

  return (
    <nav className="bottom-nav" aria-label={t('nav.home')}>
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} className="bottom-nav__item" end={item.to === '/'}>
          <span className="bottom-nav__icon" aria-hidden="true">
            {item.icon}
          </span>
          <span>{t(item.labelKey)}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export interface AppShellProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Wider content area for the dashboard and district tables. */
  wide?: boolean;
  /** Hide the bottom navigation, e.g. during the simulated call. */
  hideNav?: boolean;
  headerAction?: ReactNode;
}

export function AppShell({
  title,
  subtitle,
  children,
  wide = false,
  hideNav = false,
  headerAction,
}: AppShellProps) {
  const { t } = useI18n();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="grow">
          <h1 className="app-header__title">{title}</h1>
          {subtitle ? <div className="app-header__subtitle">{subtitle}</div> : null}
        </div>
        <div className="app-header__actions">
          {/*
            The prototype badge is permanent and deliberate. This tool tells people they may
            have diabetes using a model trained on another population; a user should never be
            unclear about what they are looking at.
          */}
          <span className="badge-prototype">{t('app.prototypeBadge')}</span>
          {headerAction}
          <LanguageSwitcher />
          <LogoutButton />
        </div>
      </header>

      <ConnectionStrip />

      <main className={`app-main${wide ? ' app-main--wide' : ''}`}>{children}</main>

      {hideNav ? null : <BottomNav />}
    </div>
  );
}
