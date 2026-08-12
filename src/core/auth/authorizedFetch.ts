import { refreshSessionOnce } from './authApi';
import { useAuthStore } from './authStore';

/** Thrown when a request needs a signed-in user and there is none (no token, and a refresh
 *  couldn't mint one). The UI catches this to open the login modal instead of showing a raw
 *  error — an anonymous visitor hitting a write is a prompt-to-sign-in, not a failure. */
export class AuthRequiredError extends Error {
  constructor() {
    super('Please sign in to continue.');
    this.name = 'AuthRequiredError';
  }
}

async function refreshAccessToken(): Promise<string | null> {
  const session = await refreshSessionOnce().catch(() => null);
  if (session) {
    useAuthStore.getState().applyAccessToken(session.access_token);
    return session.access_token;
  }
  useAuthStore.getState().clearSession();
  return null;
}

function withAuth(init: RequestInit, token: string | null): RequestInit {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  // `include` so the refresh cookie flows on /auth/* (harmless elsewhere; the cookie's own path
  // scopes it). Same-origin in dev via the Vite proxy; CORS-credentialed against a real origin.
  return { ...init, headers, credentials: 'include' };
}

/** `fetch` for the app's own protected backend: attaches the current access token, and on a 401
 *  transparently refreshes once and retries. If no session can be established, throws
 *  `AuthRequiredError` so the caller can prompt sign-in. Do NOT use this for the `/auth/*`
 *  endpoints themselves (they manage the token) — see authApi. */
export async function authorizedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  // A direct editor route can mount while startup refresh is still rotating the cookie. Join the
  // exact bootstrap promise before sending anything, then fail locally for a settled anonymous
  // visitor instead of issuing a guaranteed 401 followed by a second refresh attempt.
  const initial = useAuthStore.getState();
  if (initial.status === 'loading') await initial.bootstrap();
  const token = useAuthStore.getState().accessToken;
  if (!token) throw new AuthRequiredError();

  let res = await fetch(input, withAuth(init, token));
  if (res.status !== 401) return res;

  const fresh = await refreshAccessToken();
  if (!fresh) throw new AuthRequiredError();

  res = await fetch(input, withAuth(init, fresh));
  if (res.status === 401) {
    useAuthStore.getState().clearSession();
    throw new AuthRequiredError();
  }
  return res;
}
