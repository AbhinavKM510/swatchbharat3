/** Small presentational primitives shared across screens. */

import type { ReactNode } from 'react';

export function Spinner({ onPrimary = false, label }: { onPrimary?: boolean; label?: string }) {
  return (
    <span
      className={`spinner${onPrimary ? ' spinner--on-primary' : ''}`}
      role={label ? 'status' : 'presentation'}
      aria-label={label}
    />
  );
}

export type NoticeTone = 'info' | 'warning' | 'danger' | 'offline';

const NOTICE_ICON: Record<NoticeTone, string> = {
  info: '\u2139',
  warning: '\u26a0',
  danger: '\u26a0',
  offline: '\u2601',
};

/**
 * A callout. Always carries an icon as well as a colour, because a colour alone conveys
 * nothing to a user who cannot read the text or cannot distinguish the hue.
 */
export function Notice({
  tone = 'info',
  children,
  title,
}: {
  tone?: NoticeTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'danger' ? 'alert' : 'note'}>
      <span className="notice__icon" aria-hidden="true">
        {NOTICE_ICON[tone]}
      </span>
      <div>
        {title ? <strong style={{ display: 'block' }}>{title}</strong> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({
  icon = '\u2014',
  title,
  hint,
  action,
}: {
  icon?: string;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon" aria-hidden="true">
        {icon}
      </span>
      <p style={{ fontWeight: 600 }}>{title}</p>
      {hint ? <p className="text-sm">{hint}</p> : null}
      {action ? <div style={{ marginTop: 'var(--space-4)' }}>{action}</div> : null}
    </div>
  );
}

export function StatCard({
  value,
  label,
  alert = false,
}: {
  value: ReactNode;
  label: string;
  alert?: boolean;
}) {
  return (
    <div className={`stat${alert ? ' stat--alert' : ''}`}>
      <div className="stat__value">{value}</div>
      <div className="stat__label">{label}</div>
    </div>
  );
}

export function Tag({
  children,
  tone,
  icon,
}: {
  children: ReactNode;
  tone?: 'offline' | 'warning';
  icon?: string;
}) {
  return (
    <span className={`tag${tone ? ` tag--${tone}` : ''}`}>
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      {children}
    </span>
  );
}

/**
 * Progressive disclosure via native <details>.
 *
 * Used for the decision path and other detail a health worker does not need but a doctor
 * or a judge might ask for. Native <details> is keyboard accessible and works with no
 * JavaScript state, which is one less thing to get wrong.
 */
export function Collapsible({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="collapsible" open={defaultOpen}>
      <summary className="collapsible__summary">{summary}</summary>
      <div>{children}</div>
    </details>
  );
}

export function Card({
  title,
  hint,
  children,
  action,
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="card">
      {title ? (
        <div className="row row--between" style={{ marginBottom: 'var(--space-3)' }}>
          <div>
            <h2 className="card__title">{title}</h2>
            {hint ? <p className="card__hint">{hint}</p> : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}
