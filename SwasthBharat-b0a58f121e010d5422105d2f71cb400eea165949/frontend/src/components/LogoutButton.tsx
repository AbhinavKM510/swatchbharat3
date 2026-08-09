/**
 * Log out.
 *
 * Two behaviours that matter more than they look:
 *
 * 1. **It can refuse.** `logout()` clears this user's local records, so it declines while
 *    anything is still queued and reports how many. Field phones get shared between
 *    workers, and silently wiping a day of unsent screenings because someone tapped the
 *    wrong thing would be the worst possible bug in this app. The refusal is surfaced as a
 *    message telling them to sync first, never swallowed.
 *
 * 2. **It confirms first.** A mis-tap mid-visit costing a worker her session — or, during a
 *    demo, costing you the thread of your pitch — is worth one extra tap to prevent.
 *
 * Two variants because the two audiences differ: the header needs to survive a 320px screen
 * so it is icon-only (with a proper accessible label), while the field worker's home screen
 * gets a full-width labelled button, since an unlabelled power glyph is not something to
 * rely on for a low-literacy user.
 */

import { useState } from 'react';
import { useI18n } from '@/i18n';
import { useAuth } from '@/state/AuthContext';
import { useToast } from '@/state/ToastContext';

export interface LogoutButtonProps {
  /** `icon` for the app header, `labelled` for a full-width button in page content. */
  variant?: 'icon' | 'labelled';
}

export function LogoutButton({ variant = 'icon' }: LogoutButtonProps) {
  const { t } = useI18n();
  const { logout } = useAuth();
  const { show } = useToast();
  const [busy, setBusy] = useState(false);

  const handleLogout = async () => {
    if (busy) return;
    // eslint-disable-next-line no-alert -- a native confirm is the right weight here; a
    // custom modal would be more code and no clearer for the target user.
    if (!window.confirm(t('logout.confirm'))) return;

    setBusy(true);
    try {
      const { blockedByUnsyncedRecords } = await logout();
      if (blockedByUnsyncedRecords > 0) {
        // Deliberately long-lived: this is the message that prevents data loss.
        show(t('logout.blocked', { count: blockedByUnsyncedRecords }), 'error', 8000);
        return;
      }
      show(t('logout.done'), 'success');
      // No navigation needed — App.tsx renders the login screen once `user` becomes null.
    } finally {
      setBusy(false);
    }
  };

  if (variant === 'labelled') {
    return (
      <button
        type="button"
        className="button button--ghost button--block"
        onClick={() => void handleLogout()}
        disabled={busy}
      >
        <span aria-hidden="true">{'\u23FB'}</span>
        {t('common.logout')}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="button button--header"
      onClick={() => void handleLogout()}
      disabled={busy}
      aria-label={t('common.logout')}
      title={t('common.logout')}
    >
      <span aria-hidden="true">{'\u23FB'}</span>
    </button>
  );
}
