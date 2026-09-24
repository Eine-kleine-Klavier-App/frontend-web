import { API_BASE } from '@/core/gateway/apiBase';
import { authorizedFetch } from './authorizedFetch';

/** `/auth/google/link` returned 409 — that Google account already belongs to an account (this one
 *  or another); accounts are never merged. */
export class GoogleAlreadyLinkedError extends Error {
  constructor() {
    super('That Google account is already linked to an account.');
    this.name = 'GoogleAlreadyLinkedError';
  }
}

async function readDetail(res: Response): Promise<string | null> {
  const body: unknown = await res.json().catch(() => null);
  const detail = body && typeof body === 'object' && 'detail' in body ? (body as { detail: unknown }).detail : null;
  return typeof detail === 'string' ? detail : null;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return authorizedFetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
}

/** Sets or changes the signed-in user's password. The backend signs every OTHER device out; this
 *  session keeps working because its refresh cookie travels with the request. */
export async function setPassword(password: string): Promise<void> {
  const res = await postJson('/auth/password', { password });
  if (!res.ok) throw new Error((await readDetail(res)) ?? `Could not save the password (${res.status}).`);
}

/** Links a Google account (an id_token from Google Identity Services) to the signed-in user. */
export async function linkGoogle(idToken: string): Promise<void> {
  const res = await postJson('/auth/google/link', { id_token: idToken });
  if (res.status === 409) throw new GoogleAlreadyLinkedError();
  if (!res.ok) throw new Error((await readDetail(res)) ?? `Could not link Google (${res.status}).`);
}
