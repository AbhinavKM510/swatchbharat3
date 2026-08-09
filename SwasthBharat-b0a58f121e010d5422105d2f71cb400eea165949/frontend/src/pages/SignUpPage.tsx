/**
 * Account sign-up.
 *
 * ### Why the role selector is not just a dropdown of three equal options
 *
 * `role` decides how much patient data an account can read: `asha` sees only the screenings
 * it submitted, `doctor` sees every patient at a PHC, `officer` sees a whole district. A form
 * that let a visitor pick "doctor" and pressed submit would hand away the cross-PHC isolation
 * the rest of this system is built to guarantee.
 *
 * So field worker is the default and needs nothing. Choosing doctor or officer reveals a
 * setup-code field, and the code is checked by the server against `SETUP_TOKEN` from its own
 * environment. The client cannot bypass that by editing state — `/api/auth/register` answers
 * 403 SETUP_TOKEN_REQUIRED regardless of what this page believes. The field is shown here for
 * honesty, not for enforcement.
 *
 * ### Why the PHC is a picker and not a text box
 *
 * Codes look like `NAD-PHC-01`. Typed from memory, they get mistyped, and an account filed
 * against the wrong health centre sends its high-risk alerts to doctors with no ability to act
 * on them. The list comes from the public `/api/auth/phcs` endpoint, which exists because
 * sign-up necessarily happens before there is a token.
 *
 * ### Language first, again
 *
 * Same reasoning as the login screen: someone who cannot read English must be able to switch
 * script before being asked to understand a single field label.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { Notice, Spinner } from '@/components/ui';
import { ChoiceGroup, Field, TextField } from '@/components/forms';
import { useI18n } from '@/i18n';
import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/state/AuthContext';
import { useSyncState } from '@/state/useSyncState';
import type { PhcOption, Role } from '@/types';

/** Mirrors MIN_PASSWORD_LENGTH in backend/src/routes/auth.routes.js. */
const MIN_PASSWORD_LENGTH = 8;

/** Roles that require the server's setup code. Kept in one place so the UI cannot drift. */
const PRIVILEGED_ROLES: Role[] = ['doctor', 'officer'];

export function SignUpPage() {
  const { t, language } = useI18n();
  const { register } = useAuth();
  const sync = useSyncState();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [role, setRole] = useState<Role>('asha');
  const [phcCode, setPhcCode] = useState('');
  const [setupToken, setSetupToken] = useState('');

  const [phcs, setPhcs] = useState<PhcOption[] | null>(null);
  const [phcError, setPhcError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const needsSetupToken = PRIVILEGED_ROLES.includes(role);

  /**
   * Loads the PHC list once on mount.
   *
   * A failure here is reported but not fatal to the page: the network may come back, and
   * showing a dead form with no explanation is worse than showing the reason with a retry.
   */
  useEffect(() => {
    let cancelled = false;

    async function loadPhcs() {
      try {
        const { items } = await api.auth.phcs();
        if (cancelled) return;
        setPhcs(items);
        setPhcError(false);
        // Preselect when there is only one, so the commonest single-PHC deployment needs
        // no interaction at all.
        if (items.length === 1) setPhcCode(items[0].code);
      } catch {
        if (!cancelled) {
          setPhcs([]);
          setPhcError(true);
        }
      }
    }

    void loadPhcs();
    return () => {
      cancelled = true;
    };
  }, []);

  /** National 10 digits, matching what the server stores. */
  const nationalPhone = useMemo(() => phone.replace(/\D/g, '').slice(-10), [phone]);

  /**
   * Client-side validation, ordered so the message names the first thing actually wrong
   * rather than the last field in the form.
   *
   * Returns a translated message, or null when the form is submittable. This duplicates the
   * server's rules on purpose — it saves a round trip and gives instant feedback — but the
   * server remains the authority, and every one of these is enforced there too.
   */
  const validationError = useMemo((): string | null => {
    if (!name.trim()) return t('signup.error.nameRequired');
    if (!/^[6-9]\d{9}$/.test(nationalPhone)) return t('signup.error.phoneFormat');
    if (password.length < MIN_PASSWORD_LENGTH) {
      return t('signup.error.passwordShort', { count: MIN_PASSWORD_LENGTH });
    }
    if (password !== confirm) return t('signup.error.passwordMismatch');
    if (!phcCode) return t('signup.error.phcRequired');
    if (needsSetupToken && !setupToken.trim()) return t('signup.error.setupTokenRequired');
    return null;
  }, [name, nationalPhone, password, confirm, phcCode, needsSetupToken, setupToken, t]);

  const describeApiError = (caught: unknown): string => {
    if (caught instanceof ApiError) {
      if (caught.isNetworkError) {
        return t(sync.online ? 'signup.error.network' : 'signup.error.offline');
      }
      switch (caught.code) {
        case 'PHONE_IN_USE':
          return t('signup.error.phoneInUse');
        case 'SETUP_TOKEN_REQUIRED':
          return t('signup.error.setupTokenWrong');
        case 'PASSWORD_TOO_SHORT':
          return t('signup.error.passwordShort', { count: MIN_PASSWORD_LENGTH });
        case 'PHONE_INVALID':
          return t('signup.error.phoneFormat');
        case 'PHC_NOT_FOUND':
        case 'PHC_REQUIRED':
          return t('signup.error.phcRequired');
        case 'NAME_REQUIRED':
          return t('signup.error.nameRequired');
        case 'TOO_MANY_ATTEMPTS':
          return t('signup.error.tooMany');
        default:
          break;
      }
    }
    return t('signup.error.generic');
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    // Surface the first problem rather than letting the server answer it.
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setSubmitting(true);

    try {
      await register({
        name: name.trim(),
        phone: nationalPhone,
        password,
        role,
        language,
        phcCode,
        ...(needsSetupToken ? { setupToken: setupToken.trim() } : {}),
      });
      // Signed in already. Send them to the role's landing screen.
      navigate('/', { replace: true });
    } catch (caught) {
      setError(describeApiError(caught));
      setSubmitting(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="grow">
          <h1 className="app-header__title">{t('app.name')}</h1>
          <div className="app-header__subtitle">{t('app.tagline')}</div>
        </div>
        <span className="badge-prototype">{t('app.prototypeBadge')}</span>
      </header>

      <main className="app-main" style={{ paddingBottom: 'var(--space-6)' }}>
        <div className="stack">
          <section className="card">
            <LanguageSwitcher variant="buttons" />
          </section>

          <section className="card">
            <h2 className="card__title">{t('signup.title')}</h2>
            <p className="card__hint" style={{ marginBottom: 'var(--space-4)' }}>
              {t('signup.subtitle')}
            </p>

            <form className="stack" onSubmit={handleSubmit} noValidate>
              <TextField
                label={t('signup.name')}
                placeholder={t('signup.namePlaceholder')}
                value={name}
                onChange={setName}
                autoComplete="name"
                maxLength={80}
                required
              />

              <TextField
                label={t('signup.phone')}
                placeholder={t('login.phonePlaceholder')}
                hint={t('signup.phoneHint')}
                type="tel"
                value={phone}
                onChange={setPhone}
                autoComplete="username"
                maxLength={15}
                required
              />

              <TextField
                label={t('signup.password')}
                hint={t('signup.passwordHint', { count: MIN_PASSWORD_LENGTH })}
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                required
              />

              <TextField
                label={t('signup.confirmPassword')}
                type="password"
                value={confirm}
                onChange={setConfirm}
                autoComplete="new-password"
                required
              />

              <ChoiceGroup<Role>
                label={t('signup.role')}
                hint={t('signup.roleHint')}
                stacked
                options={[
                  { value: 'asha', label: t('role.asha') },
                  { value: 'doctor', label: t('role.doctor') },
                  { value: 'officer', label: t('role.officer') },
                ]}
                value={role}
                onChange={(next) => {
                  setRole(next);
                  setError(null);
                }}
                required
              />

              {/*
                Only rendered for privileged roles, and the explanation sits with it. Someone
                who legitimately has the code needs to know which code is being asked for;
                someone who does not should understand why the form is refusing them rather
                than assume it is broken.
              */}
              {needsSetupToken ? (
                <>
                  <Notice tone="warning">{t('signup.setupTokenWhy')}</Notice>
                  <TextField
                    label={t('signup.setupToken')}
                    hint={t('signup.setupTokenHint')}
                    type="password"
                    value={setupToken}
                    onChange={setSetupToken}
                    autoComplete="off"
                    required
                  />
                </>
              ) : null}

              <Field label={t('signup.phc')} hint={t('signup.phcHint')} required>
                {({ inputId, describedBy }) => (
                  <select
                    id={inputId}
                    className="input"
                    value={phcCode}
                    onChange={(event) => setPhcCode(event.target.value)}
                    aria-describedby={describedBy}
                    disabled={phcs === null || phcs.length === 0}
                  >
                    <option value="">
                      {phcs === null ? t('common.loading') : t('signup.phcPlaceholder')}
                    </option>
                    {(phcs ?? []).map((phc) => (
                      <option key={phc.code} value={phc.code}>
                        {phc.name}
                        {phc.block ? ` - ${phc.block}` : ''}
                      </option>
                    ))}
                  </select>
                )}
              </Field>

              {phcError ? <Notice tone="danger">{t('signup.error.phcLoadFailed')}</Notice> : null}

              {error ? <Notice tone="danger">{error}</Notice> : null}

              {!sync.online ? <Notice tone="offline">{t('signup.error.offline')}</Notice> : null}

              <button
                type="submit"
                className="button button--block button--hero"
                disabled={submitting || !sync.online}
              >
                {submitting ? (
                  <>
                    <Spinner onPrimary />
                    {t('signup.submitting')}
                  </>
                ) : (
                  t('signup.submit')
                )}
              </button>
            </form>
          </section>

          <section className="card">
            <p className="card__hint">{t('signup.haveAccount')}</p>
            <Link className="button button--ghost button--block" to="/login">
              {t('signup.goToLogin')}
            </Link>
          </section>
        </div>
      </main>
    </div>
  );
}
