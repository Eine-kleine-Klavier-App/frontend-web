import React from 'react';
import ReactDOM from 'react-dom/client';
import AppRouter from './app/AppRouter';
import { useAuthStore } from './core/auth/authStore';
import './styles/tokens.css';
import './index.css';

// Kick off the one-shot silent refresh before first paint: a returning user with a live refresh
// cookie is restored to `authed` without any interaction; everyone else settles to `anonymous`.
// Fire-and-forget — the store drives the UI off `status` as it resolves.
void useAuthStore.getState().bootstrap();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppRouter />
  </React.StrictMode>,
);
