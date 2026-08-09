/**
 * Routing and role-based landing.
 *
 * Each role lands somewhere different, because their jobs are different: a field worker
 * lands on "start a screening", a doctor on the flagged queue, an officer on district
 * trends. Sending everyone to a shared home screen would add a tap for all three.
 *
 * Routes are guarded by role rather than merely by being logged in. A field worker cannot
 * reach the district view even by typing the URL — though the real enforcement is
 * server-side; this only avoids showing a screen that would fail.
 */

import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { EmptyState, Spinner } from '@/components/ui';
import { useI18n } from '@/i18n';
import { AshaHomePage } from '@/pages/AshaHomePage';
import { AssessmentFormPage } from '@/pages/AssessmentFormPage';
import { ChatbotPage } from '@/pages/ChatbotPage';
import { DistrictTrendsPage } from '@/pages/DistrictTrendsPage';
import { DoctorDashboardPage } from '@/pages/DoctorDashboardPage';
import { LoginPage } from '@/pages/LoginPage';
import { ModelCardPage } from '@/pages/ModelCardPage';
import { PatientsPage } from '@/pages/PatientsPage';
import { RiskResultPage } from '@/pages/RiskResultPage';
import { SignUpPage } from '@/pages/SignUpPage';
import { TeleconsultPage } from '@/pages/TeleconsultPage';
import { useAuth } from '@/state/AuthContext';
import type { Role } from '@/types';

function LandingRedirect() {
  const { user } = useAuth();
  if (user?.role === 'doctor') return <Navigate to="/dashboard" replace />;
  if (user?.role === 'officer') return <Navigate to="/trends" replace />;
  return <AshaHomePage />;
}

/**
 * Guards a route by role.
 *
 * A role that does not belong on this route is sent straight to its OWN landing page
 * ("/", which `LandingRedirect` resolves per role) rather than being shown a "you do not
 * have access to this" screen. An officer has no legitimate reason to be looking at
 * Screening or Patients in the first place — those tabs are not even in their bottom nav —
 * so the only way to land here is a stale link or the back/forward button, and a silent
 * redirect back to where they belong is a better answer than a dead end with a message.
 *
 * The server remains the real enforcement either way; this only decides what the UI shows
 * for a role that should not be here.
 */
function RequireRole({ roles, children }: { roles: Role[]; children: React.ReactElement }) {
  const { user } = useAuth();

  if (!user) return <Navigate to="/" replace />;
  if (!roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function NotFoundPage() {
  const { t } = useI18n();
  return (
    <AppShell title={t('errors.pageNotFound')}>
      <EmptyState
        icon={'\u2014'}
        title={t('errors.pageNotFound')}
        action={
          <Link className="button" to="/">
            {t('errors.goHome')}
          </Link>
        }
      />
    </AppShell>
  );
}

export function App() {
  const { user, initialising } = useAuth();
  const { t } = useI18n();

  if (initialising) {
    return (
      <div className="centre-screen">
        <Spinner label={t('common.loading')} />
        <p className="muted">{t('common.loading')}</p>
      </div>
    );
  }

  if (!user) {
    /**
     * The model card stays reachable without a login: the transparency page should not
     * require an account to read.
     *
     * `/signup` is an explicit route rather than a tab inside the login screen so it can be
     * linked to and shared. `*` still falls through to login, which keeps the previous
     * behaviour that any deep link while signed out lands on sign-in rather than a 404.
     */
    return (
      <Routes>
        <Route path="/model" element={<ModelCardPage />} />
        <Route path="/signup" element={<SignUpPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<LandingRedirect />} />

      <Route
        path="/screening"
        element={
          <RequireRole roles={['asha', 'doctor']}>
            <AssessmentFormPage />
          </RequireRole>
        }
      />
      <Route path="/result/:clientId" element={<RiskResultPage />} />
      <Route path="/teleconsult/:clientId" element={<TeleconsultPage />} />

      <Route
        path="/patients"
        element={
          <RequireRole roles={['asha', 'doctor']}>
            <PatientsPage />
          </RequireRole>
        }
      />

      <Route
        path="/dashboard"
        element={
          <RequireRole roles={['doctor', 'officer']}>
            <DoctorDashboardPage />
          </RequireRole>
        }
      />

      <Route
        path="/trends"
        element={
          <RequireRole roles={['doctor', 'officer']}>
            <DistrictTrendsPage />
          </RequireRole>
        }
      />

      <Route path="/help" element={<ChatbotPage />} />
      <Route path="/model" element={<ModelCardPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
