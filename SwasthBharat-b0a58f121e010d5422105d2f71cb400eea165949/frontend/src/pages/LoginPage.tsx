/**
 * Login.
 *
 * The language switcher sits ABOVE the form, as large tappable buttons in each script. A
 * worker who cannot read English must be able to change the language before being asked to
 * understand a single field label — putting the switcher in a settings screen behind login
 * would be a dead end for exactly the people this app is for.
 *
 * The demo accounts are listed on the screen and fill the form on tap. That is a deliberate
 * demo affordance, not an accident: presenting from a phone means nobody wants to type a
 * 10-digit number on stage. It is gated on `import.meta.env.DEV` plus an explicit env flag,
 * so a production build does not advertise credentials.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ConfirmationResult } from 'firebase/auth';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { Notice, Spinner } from '@/components/ui';
import { TextField } from '@/components/forms';
import { useI18n } from '@/i18n';
import { ApiError } from '@/lib/api';
// Config and constants only. The SDK-touching module is imported dynamically below, and
// must never be imported statically — see lib/firebaseAuth.ts for why.
import { RECAPTCHA_CONTAINER_ID, isPhoneSignInAvailable } from '@/lib/firebaseConfig';
import { useAuth } from '@/state/AuthContext';
import { useSyncState } from '@/state/useSyncState';

const DEMO_ACCOUNTS = [
  { roleKey: 'login.demoAsha', phone: '9800000001', name: 'Sunita Das' },
  { roleKey: 'login.demoDoctor', phone: '9800000010', name: 'Dr. Arun Ghosh' },
  { roleKey: 'login.demoOfficer', phone: '9800000020', name: 'Dr. Meera Nair' },
] as const;

const DEMO_PASSWORD = import.meta.env.VITE_DEMO_PASSWORD ?? 'demo1234';

/** Demo hints appear in dev builds, or when explicitly switched on for a staged demo. */
const SHOW_DEMO_HINTS = import.meta.env.DEV || import.meta.env.VITE_SHOW_DEMO_LOGINS === 'true';

/** Phone-OTP sign-in progresses through these. `idle` also means "not being used". */
type OtpStage = 'idle' | 'sending' | 'awaitingCode' | 'verifying';

export function LoginPage() {
  const { t } = useI18n();
  const { login, loginWithFirebase } = useAuth();
  const sync = useSyncState();

  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [otpStage, setOtpStage] = useState<OtpStage>('idle');
  const [otpCode, setOtpCode] = useState('');
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null);

  const phoneSignInOffered = isPhoneSignInAvailable();
  const otpBusy = otpStage === 'sending' || otpStage === 'verifying';

  /** Maps an API failure onto a translated message. Shared by both sign-in paths. */
  const describeApiError = (caught: unknown): string => {
    if (caught instanceof ApiError) {
      if (caught.isNetworkError) return t(sync.online ? 'login.error.network' : 'login.error.offline');
      if (caught.status === 401) return t('login.error.invalid');
      if (caught.status === 501) return t('login.error.phoneSignInUnavailable');
      if (caught.code === 'ACCOUNT_NOT_PROVISIONED') return t('login.error.notProvisioned');
      if (caught.code === 'FIREBASE_UID_MISMATCH') return t('login.error.otpLinkMismatch');
      if (caught.status === 403) return t('login.error.accountDisabled');
    }
    return t('login.error.generic');
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;

    setError(null);
    setSubmitting(true);

    try {
      await login(phone.trim(), password);
      // Navigation is handled by the router reacting to the auth state change.
    } catch (caught) {
      setError(describeApiError(caught));
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * Requests an SMS code.
   *
   * The Firebase SDK is imported here rather than at module scope so it lands in its own
   * chunk and never enters the offline precache. See lib/firebaseAuth.ts.
   */
  const handleSendOtp = async () => {
    if (otpBusy) return;
    setError(null);

    const national = phone.trim().replace(/\D/g, '').slice(-10);
    if (!/^[6-9]\d{9}$/.test(national)) {
      setError(t('login.error.phoneFormat'));
      return;
    }

    setOtpStage('sending');
    try {
      const { sendOtp } = await import('@/lib/firebaseAuth');
      setConfirmation(await sendOtp(national));
      setOtpStage('awaitingCode');
    } catch (caught) {
      // Firebase's own error codes, which the shared API mapper does not cover.
      const code = (caught as { code?: string })?.code ?? '';

      /**
       * Logged, not just mapped.
       *
       * Every unmapped failure used to collapse into one generic "could not send" toast,
       * which is unactionable — the difference between "phone auth is not enabled in the
       * console", "this domain is not authorised", and "that number is not real" is the
       * whole diagnosis, and Firebase puts it in `code`. The user-facing text stays
       * friendly; the console gets the truth.
       */
      console.error('[auth] sendOtp failed', code || caught, caught);

      setError(
        code === 'auth/too-many-requests'
          ? t('login.error.otpTooMany')
          : code === 'auth/invalid-phone-number'
            ? t('login.error.phoneFormat')
            : // Phone provider switched off in the Firebase console.
              code === 'auth/operation-not-allowed'
              ? t('login.error.otpNotEnabled')
              : // The page's origin is not in the console's authorised-domain list.
                code === 'auth/unauthorized-domain'
                ? t('login.error.otpDomain')
                : // reCAPTCHA could not be satisfied, or the app credential is wrong.
                  code === 'auth/captcha-check-failed' || code === 'auth/invalid-app-credential'
                  ? t('login.error.otpCaptcha')
                  : // Blaze plan / SMS quota problem.
                    code === 'auth/billing-not-enabled' || code === 'auth/quota-exceeded'
                    ? t('login.error.otpQuota')
                    : t('login.error.otpSendFailed'),
      );
      const { resetOtpVerifier } = await import('@/lib/firebaseAuth');
      resetOtpVerifier();
      setOtpStage('idle');
    }
  };

  const handleVerifyOtp = async () => {
    if (otpBusy || !confirmation) return;
    setError(null);
    setOtpStage('verifying');

    try {
      const { confirmOtp } = await import('@/lib/firebaseAuth');
      const idToken = await confirmOtp(confirmation, otpCode.trim());
      await loginWithFirebase(idToken);
      // Router reacts to the auth state change from here.
    } catch (caught) {
      const code = (caught as { code?: string })?.code ?? '';
      setError(
        code === 'auth/invalid-verification-code'
          ? t('login.error.otpWrongCode')
          : code === 'auth/code-expired'
            ? t('login.error.otpExpired')
            : describeApiError(caught),
      );
      setOtpStage('awaitingCode');
    }
  };

  const cancelOtp = async () => {
    setOtpCode('');
    setConfirmation(null);
    setOtpStage('idle');
    setError(null);
    const { resetOtpVerifier } = await import('@/lib/firebaseAuth');
    resetOtpVerifier();
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
          {/* Language before anything else. */}
          <section className="card">
            <LanguageSwitcher variant="buttons" />
          </section>

          <section className="card">
            <h2 className="card__title">{t('login.title')}</h2>
            <p className="card__hint" style={{ marginBottom: 'var(--space-4)' }}>
              {t('login.subtitle')}
            </p>

            <form className="stack" onSubmit={handleSubmit} noValidate>
              <TextField
                label={t('login.phone')}
                placeholder={t('login.phonePlaceholder')}
                type="tel"
                value={phone}
                onChange={setPhone}
                autoComplete="username"
                maxLength={15}
                required
              />

              <TextField
                label={t('login.password')}
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                required
              />

              {error ? <Notice tone="danger">{error}</Notice> : null}

              {!sync.online ? <Notice tone="offline">{t('login.error.offline')}</Notice> : null}

              <button type="submit" className="button button--block button--hero" disabled={submitting}>
                {submitting ? (
                  <>
                    <Spinner onPrimary />
                    {t('login.submitting')}
                  </>
                ) : (
                  t('login.submit')
                )}
              </button>
            </form>

            {/*
              Sign-up sits below the login form, not beside it as an equal tab. Almost every
              visit to this screen is a returning worker signing in; account creation is a
              once-ever action and should not compete for the primary position.
            */}
            <div className="stack stack--tight" style={{ marginTop: 'var(--space-4)' }}>
              <p className="card__hint">{t('login.noAccount')}</p>
              <Link className="button button--ghost button--block" to="/signup">
                {t('login.goToSignUp')}
              </Link>
            </div>
          </section>

          {/*
            Phone-OTP sign-in. A SECOND way in, never a replacement.

            Password stays the primary form above it, for two reasons: it is the path every
            verification script exercises, and it works against a reachable API with no SMS
            path at all. This whole section disappears unless a Firebase project is
            configured AND phone sign-in is explicitly switched on, so the default build
            shows exactly the login screen it always did.

            It reuses the mobile number already typed into the form above rather than asking
            for it twice — the same number identifies the account either way.
          */}
          {phoneSignInOffered ? (
            <section className="card">
              <h2 className="card__title">{t('login.otpTitle')}</h2>
              <p className="card__hint" style={{ marginBottom: 'var(--space-3)' }}>
                {t('login.otpHint')}
              </p>

              <div className="stack stack--tight">
                {otpStage === 'awaitingCode' || otpStage === 'verifying' ? (
                  <>
                    <TextField
                      label={t('login.otpCode')}
                      type="tel"
                      value={otpCode}
                      onChange={setOtpCode}
                      autoComplete="one-time-code"
                      maxLength={6}
                      required
                    />
                    <button
                      type="button"
                      className="button button--block"
                      onClick={() => void handleVerifyOtp()}
                      disabled={otpBusy || otpCode.trim().length < 6}
                    >
                      {otpStage === 'verifying' ? (
                        <>
                          <Spinner onPrimary />
                          {t('login.otpVerifying')}
                        </>
                      ) : (
                        t('login.otpVerify')
                      )}
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--block"
                      onClick={() => void cancelOtp()}
                      disabled={otpBusy}
                    >
                      {t('common.cancel')}
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="button button--secondary button--block"
                    onClick={() => void handleSendOtp()}
                    disabled={otpBusy || !sync.online}
                  >
                    {otpStage === 'sending' ? (
                      <>
                        <Spinner />
                        {t('login.otpSending')}
                      </>
                    ) : (
                      t('login.otpSend')
                    )}
                  </button>
                )}

                {!sync.online ? <Notice tone="offline">{t('login.otpNeedsNetwork')}</Notice> : null}
              </div>

              {/*
                Firebase's invisible reCAPTCHA mounts here. It must be in the DOM before
                signInWithPhoneNumber is called, which is why it is rendered unconditionally
                inside this section rather than created on demand.
              */}
              <div id={RECAPTCHA_CONTAINER_ID} />
            </section>
          ) : null}

          {SHOW_DEMO_HINTS ? (
            <section className="card">
              <h2 className="card__title">{t('login.demoTitle')}</h2>
              <p className="card__hint" style={{ marginBottom: 'var(--space-3)' }}>
                {t('login.demoHint', { password: DEMO_PASSWORD })}
              </p>

              <div className="stack stack--tight">
                {DEMO_ACCOUNTS.map((account) => (
                  <button
                    key={account.phone}
                    type="button"
                    className="choice choice--stacked"
                    onClick={() => {
                      setPhone(account.phone);
                      setPassword(DEMO_PASSWORD);
                      setError(null);
                    }}
                  >
                    <span className="grow">
                      <strong style={{ display: 'block' }}>{t(account.roleKey)}</strong>
                      <span className="text-sm muted">
                        {account.name} &middot; {account.phone}
                      </span>
                    </span>
                    <span className="text-sm">{t('login.fillDemo')}</span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </main>
    </div>
  );
}
