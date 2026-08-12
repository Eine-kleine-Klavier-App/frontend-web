import { create } from 'zustand';
import {
  fetchCurrentUser,
  googleSignIn,
  logoutSession,
  refreshSessionOnce,
  type AccessTokenResponse,
} from './authApi';
import { clearPrivateBrowseQueries } from '@/core/gateway/browseQueryCache';

/** `loading` — the one-shot silent-refresh on app start hasn't resolved yet (we don't yet know if
 *  there's a returning session). `anonymous` — no session; reads are free, writes must prompt
 *  sign-in. `authed` — a live access token is held. */
export type AuthStatus = 'loading' | 'anonymous' | 'authed';

interface AuthState {
  status: AuthStatus;
  /** In MEMORY only — never localStorage. Durability across reloads comes from the httponly
   *  refresh cookie + the silent refresh in `bootstrap`, not from persisting the access token. */
  accessToken: string | null;
  /** The internal user id, decoded from the token's `sub` claim. */
  userId: string | null;
  /** Known only from the signup step the user just completed; null after a silent refresh restores
   *  a session (the backend exposes no username — see authApi note). Display code must tolerate null. */
  username: string | null;

  /** One-shot on app start: try to restore a session from the refresh cookie. Never throws —
   *  failure just means anonymous. Idempotent (safe under StrictMode's double effect). */
  bootstrap: () => Promise<void>;
  /** Complete the network half of Google sign-in without exposing the new identity to React yet.
   *  The modal commits the returned session inside the auth scene transition, so the old and new
   *  shells never race each other on screen. */
  prepareGoogleSignIn: (idToken: string, username?: string) => Promise<PreparedAuthSession>;
  applyPreparedSession: (session: PreparedAuthSession) => void;
  signOut: () => void;
  /** Applies a freshly-minted access token (used by the refresh path in authorizedFetch). */
  applyAccessToken: (token: string) => void;
  /** Drops the session → anonymous (refresh failed / signed out). */
  clearSession: () => void;
}

/** Reads the `sub` claim (user id) out of a JWT without verifying it — the backend already
 *  verified it; the client just needs the id for display/identity. Returns null on any malformed
 *  token rather than throwing. */
function decodeSub(token: string): string | null {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { sub?: unknown };
    return typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}

let bootstrapPromise: Promise<void> | null = null;

export interface PreparedAuthSession {
  accessToken: string;
  userId: string | null;
  username: string | null;
}

/** Resolves the complete UI identity before publishing it. `/auth/me` is allowed to fail because
 *  the access token is already valid; in that case the signup name (if any) remains the fallback. */
async function prepareSession(token: string, fallbackUsername: string | null = null): Promise<PreparedAuthSession> {
  let userId = decodeSub(token);
  let username = fallbackUsername;
  try {
    const profile = await fetchCurrentUser(token);
    userId = profile.user_id;
    username = profile.username;
  } catch {
    // The session is still valid without profile display data.
  }
  return { accessToken: token, userId, username };
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  accessToken: null,
  userId: null,
  username: null,

  bootstrap: async () => {
    if (!bootstrapPromise) {
      bootstrapPromise = (async () => {
        let session: AccessTokenResponse | null = null;
        try {
          session = await refreshSessionOnce();
        } catch {
          session = null; // network/other failure → treat as anonymous, don't wedge the app
        }
        if (session) {
          const prepared = await prepareSession(session.access_token);
          set({ status: 'authed', ...prepared });
        } else {
          set({ status: 'anonymous', accessToken: null, userId: null, username: null });
        }
      })();
    }
    await bootstrapPromise;
  },

  prepareGoogleSignIn: async (idToken, username) => {
    const session = await googleSignIn(idToken, username);
    return prepareSession(session.access_token, username ?? null);
  },

  applyPreparedSession: (session) => {
    // A completed sign-in starts a fresh personal-data cache even if the same account signs back
    // in later. Public catalog reads remain reusable across the session boundary.
    clearPrivateBrowseQueries();
    set({ status: 'authed', ...session });
  },

  signOut: () => {
    // Clear locally first so the UI flips to anonymous immediately; revoke server-side in the
    // background (best-effort) so a reload's silent refresh can't resurrect the session.
    clearPrivateBrowseQueries();
    set({ status: 'anonymous', accessToken: null, userId: null, username: null });
    void logoutSession();
  },

  applyAccessToken: (token) => {
    set({ status: 'authed', accessToken: token, userId: decodeSub(token) });
  },

  clearSession: () => {
    clearPrivateBrowseQueries();
    set({ status: 'anonymous', accessToken: null, userId: null, username: null });
  },
}));
