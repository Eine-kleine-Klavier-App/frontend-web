// Minimal typing for the slice of Google Identity Services we use (the id-token / "Sign in with
// Google" flow). Loaded from Google's CDN at runtime, so it isn't in our bundle's types.
interface GoogleCredentialResponse {
  credential: string; // the id_token (a JWT) to hand to POST /auth/google
}

interface GoogleIdConfig {
  client_id: string;
  callback: (response: GoogleCredentialResponse) => void;
  ux_mode?: 'popup' | 'redirect';
}

interface GoogleButtonOptions {
  theme?: 'outline' | 'filled_blue' | 'filled_black';
  size?: 'small' | 'medium' | 'large';
  text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
  shape?: 'rectangular' | 'pill' | 'circle' | 'square';
  width?: number;
  logo_alignment?: 'left' | 'center';
}

interface GoogleAccountsId {
  initialize: (config: GoogleIdConfig) => void;
  renderButton: (parent: HTMLElement, options: GoogleButtonOptions) => void;
  cancel: () => void;
}

interface GoogleCredentialReceiver {
  owner: symbol;
  receive: (idToken: string) => void;
}

interface GoogleIdentityRuntime {
  initializedClientId: string | null;
  activeReceiver: GoogleCredentialReceiver | null;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
    /** Survives modal remounts and Vite HMR: GIS itself is page-global, so its lifecycle must be
     *  page-global too rather than scoped to whichever React button happens to be mounted. */
    __pianoGoogleIdentityRuntime?: GoogleIdentityRuntime;
  }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client';

/** The public OAuth client id (see .env / VITE_GOOGLE_CLIENT_ID). Empty when unconfigured → the
 *  sign-in button renders a "not configured" note instead of attempting the flow. */
export const GOOGLE_CLIENT_ID: string = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

let loader: Promise<void> | null = null;

function runtime(): GoogleIdentityRuntime {
  return (window.__pianoGoogleIdentityRuntime ??= {
    initializedClientId: null,
    activeReceiver: null,
  });
}

/** Loads the Google Identity Services script once (idempotent, shared promise). Resolves when
 *  `window.google.accounts.id` is available; rejects if the script fails to load. */
export function loadGoogleIdentity(): Promise<void> {
  if (loader) return loader;
  loader = new Promise<void>((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Google sign-in failed to load.')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google sign-in failed to load.'));
    document.head.appendChild(script);
  });
  return loader;
}

/** Mounts the official GIS button into a disposable React-owned container.
 *
 *  GIS has one implicit client per page: `initialize()` is therefore called exactly once while
 *  `renderButton()` may be called for every fresh modal container. The stable SDK callback
 *  dispatches to the currently mounted button owner; cleanup is token-checked so an exiting old
 *  modal can never detach a newer modal's receiver. */
export async function mountGoogleSignInButton(
  parent: HTMLElement,
  onCredential: (idToken: string) => void,
): Promise<() => void> {
  if (!GOOGLE_CLIENT_ID) throw new Error('Google sign-in is not configured.');
  await loadGoogleIdentity();

  const identity = window.google?.accounts.id;
  if (!identity) throw new Error('Google sign-in failed to load.');

  const shared = runtime();
  if (shared.initializedClientId && shared.initializedClientId !== GOOGLE_CLIENT_ID) {
    throw new Error('Google sign-in configuration changed. Reload the page and try again.');
  }
  if (!shared.initializedClientId) {
    identity.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: (response) => runtime().activeReceiver?.receive(response.credential),
      // Google's secure chooser is a separate popup in the target browser. Keep the application
      // mounted underneath it; the credential callback resumes the in-app flow after it returns.
      ux_mode: 'popup',
    });
    shared.initializedClientId = GOOGLE_CLIENT_ID;
  }

  const owner = Symbol('google-sign-in-button');
  shared.activeReceiver = { owner, receive: onCredential };
  parent.replaceChildren();
  try {
    identity.renderButton(parent, {
      theme: 'outline',
      size: 'large',
      text: 'continue_with',
      shape: 'pill',
      logo_alignment: 'center',
      width: 280,
    });
  } catch (error) {
    if (shared.activeReceiver?.owner === owner) shared.activeReceiver = null;
    throw error;
  }

  return () => {
    const shared = runtime();
    // StrictMode may resolve the first (already cancelled) mount after a newer mount has claimed
    // the same React ref/container. That stale disposer must not erase the newer GIS button.
    if (shared.activeReceiver?.owner !== owner) return;
    shared.activeReceiver = null;
    parent.replaceChildren();
  };
}
