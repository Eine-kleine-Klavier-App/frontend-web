import { create } from 'zustand';
import { useAuthStore } from './authStore';

/** Drives the login modal AND the "continue what you were doing" intent. A write/logged-in-only
 *  control never navigates or mutates directly for an anonymous user — it hands its action here,
 *  the modal opens, and the action runs only after a successful sign-in. */
interface AuthPromptState {
  isOpen: boolean;
  /** What to run once sign-in succeeds (e.g. create the draft, go to /you). Cleared on close. */
  pending: (() => void) | null;
  open: (onSuccess?: () => void) => void;
  close: () => void;
  /** Called by the modal after a successful sign-in: closes and fires the pending action. */
  succeed: () => void;
}

export const useAuthPrompt = create<AuthPromptState>((set, get) => ({
  isOpen: false,
  pending: null,
  open: (onSuccess) => set({ isOpen: true, pending: onSuccess ?? null }),
  close: () => set({ isOpen: false, pending: null }),
  succeed: () => {
    const { pending } = get();
    set({ isOpen: false, pending: null });
    pending?.();
  },
}));

/** Runs `action` immediately if the user is signed in; otherwise opens the login modal and runs it
 *  after they sign in. THE single gate every write / logged-in-only entry point calls. Usable
 *  outside React (reads the store via getState). */
export function requireAuth(action: () => void): void {
  if (useAuthStore.getState().status === 'authed') action();
  else useAuthPrompt.getState().open(action);
}
