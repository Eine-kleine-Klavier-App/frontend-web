import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthPrompt } from './authPrompt';

/** Personal, logged-in-only screens (Library, You) call this. When reached anonymously, it bounces
 *  to Explore and pops the login modal OVER that context — there is no intermediary "sign in here"
 *  screen ([[auth-product-model]]). Pass the "should gate" flag; a no-op once signed in. */
export function useAnonGate(shouldGate: boolean): void {
  const navigate = useNavigate();
  useEffect(() => {
    if (!shouldGate) return;
    useAuthPrompt.getState().open();
    navigate('/explore', { replace: true });
  }, [shouldGate, navigate]);
}
