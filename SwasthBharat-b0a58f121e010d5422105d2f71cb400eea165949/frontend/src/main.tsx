/**
 * Application entry point.
 *
 * Provider order is load-bearing:
 *
 *   I18nProvider   must be outermost — AuthProvider adopts the logged-in user's language,
 *                  and every error message below it needs translation.
 *   ToastProvider  above AuthProvider so auth events can raise toasts.
 *   AuthProvider   owns the session and drives the router.
 *   BrowserRouter  innermost of the providers, since routes consume all of the above.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from '@/App';
import { I18nProvider } from '@/i18n';
import { AuthProvider } from '@/state/AuthContext';
import { ToastProvider } from '@/state/ToastContext';
import '@/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </I18nProvider>
  </StrictMode>,
);
