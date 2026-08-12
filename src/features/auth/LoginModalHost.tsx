import { AnimatePresence } from 'motion/react';
import { useAuthPrompt } from '@/core/auth/authPrompt';
import { LoginModal } from './LoginModal';
import { useAuthSceneTransitionActive } from './authSceneTransition';

/** Mounts the login modal once, driven by the shared auth-prompt store. Any control can call
 *  `requireAuth(...)` / `useAuthPrompt.open(...)` from anywhere in the tree and this renders the
 *  modal — no screen owns it. `AnimatePresence` gives it its exit animation on close. */
export function LoginModalHost() {
  const isOpen = useAuthPrompt((s) => s.isOpen);
  const authSceneTransitionActive = useAuthSceneTransitionActive();
  // A successful sign-in is already represented by the frozen scene layer. Unmount the real
  // dialog in the same commit instead of letting AnimatePresence keep a second copy above it.
  if (!isOpen && authSceneTransitionActive) return null;
  return <AnimatePresence>{isOpen && <LoginModal />}</AnimatePresence>;
}
