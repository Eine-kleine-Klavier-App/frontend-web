import { useEffect, useRef, useState } from 'react';
import { GOOGLE_CLIENT_ID, mountGoogleSignInButton } from '@/core/auth/googleIdentity';

/** Renders the official "Sign in with Google" button (Google Identity Services). On success it
 *  hands the raw id_token up via `onCredential`; the parent exchanges it at POST /auth/google.
 *  The page-global GIS lifecycle lives in `googleIdentity.ts`; this component owns only its fresh
 *  DOM container and current callback, so closing/reopening the modal never re-initializes GIS. */
export function GoogleSignInButton({
  onCredential,
  onError,
}: {
  onCredential: (idToken: string) => void;
  onError?: (message: string) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const onCredentialRef = useRef(onCredential);
  const onErrorRef = useRef(onError);
  onCredentialRef.current = onCredential;
  onErrorRef.current = onError;

  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading');

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) {
      setStatus('unavailable');
      onErrorRef.current?.('Google sign-in is not configured.');
      return;
    }
    const mount = mountRef.current;
    if (!mount) return;
    let cancelled = false;
    let dispose: (() => void) | null = null;
    void mountGoogleSignInButton(mount, (idToken) => onCredentialRef.current(idToken))
      .then((nextDispose) => {
        if (cancelled) {
          nextDispose();
          return;
        }
        dispose = nextDispose;
        setStatus('ready');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setStatus('unavailable');
        onErrorRef.current?.(e instanceof Error ? e.message : 'Google sign-in failed to load.');
      });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  if (status === 'unavailable') {
    return <p className="auth-modal-unavailable">Google sign-in is unavailable right now.</p>;
  }
  return <div className="google-btn-mount" ref={mountRef} data-loading={status === 'loading' ? '' : undefined} />;
}
