// Same-origin `/api` in dev via the Vite proxy (see vite.config.ts -> backend on :8000).
// A built/deployed app has no dev proxy, so VITE_API_BASE_URL (a real backend origin) takes
// over when it's set; unset, this stays '/api' for local dev exactly as before.
export const API_BASE: string = import.meta.env.VITE_API_BASE_URL || '/api';
