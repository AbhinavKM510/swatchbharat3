/**
 * Language switcher.
 *
 * Every option is written in its own script (বাংলা, हिन्दी, English), never translated into
 * the currently active language. Someone who cannot read the current language must still be
 * able to find their own — which is impossible if the Bengali option is labelled "Bengali"
 * in Hindi.
 *
 * The choice is persisted locally immediately, and pushed to the server best-effort so the
 * worker's next device comes up in the right language.
 */

import { useI18n, type Language } from '@/i18n';
import { api, getToken } from '@/lib/api';

export function LanguageSwitcher({ variant = 'header' }: { variant?: 'header' | 'buttons' }) {
  const { language, setLanguage, languageOptions, t } = useI18n();

  const choose = (next: Language) => {
    setLanguage(next);
    // Best effort. A failure here is invisible and harmless: the local choice already
    // applied, and this only affects a future login on another device.
    if (getToken()) void api.auth.setLanguage(next).catch(() => undefined);
  };

  if (variant === 'buttons') {
    return (
      <div className="field">
        <span className="field__label">{t('login.chooseLanguage')}</span>
        <div className="choice-group">
          {languageOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className="choice"
              aria-pressed={language === option.value}
              onClick={() => choose(option.value)}
              lang={option.value}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <label className="row" style={{ gap: 'var(--space-1)' }}>
      <span className="sr-only">{t('common.language')}</span>
      <select
        className="button button--header"
        style={{ paddingRight: 'var(--space-2)' }}
        value={language}
        onChange={(event) => choose(event.target.value as Language)}
        aria-label={t('common.language')}
      >
        {languageOptions.map((option) => (
          <option key={option.value} value={option.value} lang={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
