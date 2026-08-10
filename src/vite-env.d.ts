/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend base URL for a built (non-dev-proxy) deployment. Falls back to the dev
   *  proxy's `/api` prefix (see vite.config.ts) when unset. */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
