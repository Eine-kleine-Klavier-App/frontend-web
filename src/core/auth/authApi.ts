import { API_BASE } from '@/core/gateway/apiBase';

/** The backend's `AccessTokenResponse` (see PianoAppBackend `session/router.py`) — the ONLY thing
 *  sign-in/refresh return. Note there is no username here (nor in the JWT, which carries just
 *  `sub` = the internal user id): the client knows the username only at the moment the user typed
 *  it during signup, never after a silent refresh. */
export interface AccessTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/** New account needs a username — `/auth/google` returned 422 `UsernameRequiredError`. The caller
 *  should collect a username and retry `googleSignIn` with the SAME id_token. */
export class UsernameRequiredError extends Error {
  constructor() {
    super('A username is required to create an account.');
    this.name = 'UsernameRequiredError';
  }
}

/** The chosen username is taken — `/auth/google` returned 409. Retry with a different one. */
export class UsernameConflictError extends Error {
  constructor(message?: string) {
    super(message ?? 'That username is already taken.');
    this.name = 'UsernameConflictError';
  }
}

/** Google rejected the credential (401) — the id_token is invalid/expired; restart the Google flow. */
export class InvalidCredentialError extends Error {
  constructor(message?: string) {
    super(message ?? 'Google sign-in failed. Please try again.');
    this.name = 'InvalidCredentialError';
  }
}

async function readDetail(res: Response): Promise<unknown> {
  const body: unknown = await res.json().catch(() => null);
  return body && typeof body === 'object' && 'detail' in body ? (body as { detail: unknown }).detail : null;
}

/** Exchanges a Google id_token for an app session. On a brand-new account the backend needs a
 *  username: without one it answers 422 → we throw `UsernameRequiredError` (distinguished from a
 *  Pydantic 422, whose `detail` is an array, not a string). The refresh cookie is set on this
 *  response, so `credentials: 'include'` is required. */
export async function googleSignIn(idToken: string, username?: string): Promise<AccessTokenResponse> {
  const res = await fetch(`${API_BASE}/auth/google`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ id_token: idToken, ...(username ? { username } : {}) }),
  });
  if (res.ok) return (await res.json()) as AccessTokenResponse;

  const detail = await readDetail(res);
  if (res.status === 422 && typeof detail === 'string') throw new UsernameRequiredError();
  if (res.status === 409) throw new UsernameConflictError(typeof detail === 'string' ? detail : undefined);
  if (res.status === 401) throw new InvalidCredentialError(typeof detail === 'string' ? detail : undefined);
  throw new Error(typeof detail === 'string' ? detail : `Sign-in failed (${res.status}).`);
}

/** Rotates the refresh cookie into a new access token. Returns null on 401 (no/expired cookie →
 *  the visitor is simply anonymous, not an error). The httponly cookie is sent automatically, so
 *  `credentials: 'include'`; there is no request body. */
async function refreshSession(): Promise<AccessTokenResponse | null> {
  const res = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Session refresh failed (${res.status}).`);
  return (await res.json()) as AccessTokenResponse;
}

// Refresh tokens rotate, so every caller in the app — startup bootstrap and 401 recovery alike —
// must join one in-flight request. Two independent locks still allow two rotations; the lock
// therefore lives beside the refresh endpoint itself, below both consumers.
let inflightRefresh: Promise<AccessTokenResponse | null> | null = null;

export function refreshSessionOnce(): Promise<AccessTokenResponse | null> {
  if (!inflightRefresh) {
    inflightRefresh = refreshSession().finally(() => {
      inflightRefresh = null;
    });
  }
  return inflightRefresh;
}

/** The backend's `CurrentUserResponse` from `GET /auth/me` — the ONLY source of the username after
 *  a silent refresh (it isn't in the token). Takes the access token explicitly rather than going
 *  through `authorizedFetch`: the caller has just minted a fresh token, so no refresh-retry is
 *  wanted here (and it keeps this low-level module free of an import cycle). */
export interface CurrentUser {
  user_id: string;
  username: string;
}

export async function fetchCurrentUser(accessToken: string): Promise<CurrentUser> {
  const res = await fetch(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`Failed to load profile (${res.status}).`);
  return (await res.json()) as CurrentUser;
}

/** Ends the session server-side: deletes the refresh session and clears the httponly cookie
 *  (which JS cannot clear itself). Best-effort — a failure here still lets the client drop its
 *  own state; the endpoint returns 204 even without a cookie. */
export async function logoutSession(): Promise<void> {
  await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' }).catch(() => undefined);
}
