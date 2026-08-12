/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend base URL for a built (non-dev-proxy) deployment. Falls back to the dev
   *  proxy's `/api` prefix (see vite.config.ts) when unset. */
  readonly VITE_API_BASE_URL?: string;
  /** Google OAuth client id for Google Identity Services (public). Must match one of the
   *  backend's GOOGLE_CLIENT_IDS. Unset → sign-in is unavailable (button not rendered). */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
