import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { UsernameConflictError, UsernameRequiredError } from '@/core/auth/authApi';
import { useAuthStore, type PreparedAuthSession } from '@/core/auth/authStore';
import { useAuthPrompt } from '@/core/auth/authPrompt';
import { GoogleSignInButton } from './GoogleSignInButton';
import { runAuthSceneTransition } from './authSceneTransition';
import { Button } from '@/ui/Button';
import { BrandMark, CloseIcon, EditIcon, LibraryIcon, PracticeIcon } from '@/ui/icons';
import { springGentle, springSmooth } from '@/styles/motion';

type Step = 'choose' | 'username';

// What signing in unlocks — fills the modal with a real reason to sign in instead of empty space,
// in the app's own icon family (no emoji, per DESIGN.md).
const BENEFITS: { Icon: () => JSX.Element; text: string }[] = [
  { Icon: EditIcon, text: 'Create and edit your own scores' },
  { Icon: LibraryIcon, text: 'Save and organize your library' },
  { Icon: PracticeIcon, text: 'Track your progress over time' },
];

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** The sign-in modal. Reads is a free act; this appears only when an anonymous visitor reaches a
 *  write / logged-in-only action ([[auth-product-model]]). Two-step Google flow: a credential that
 *  belongs to a brand-new account comes back as `UsernameRequiredError` → we keep the SAME id_token
 *  and ask for a username, then resend. Closing (backdrop / Esc / ✕) cancels without side effects. */
export function LoginModal() {
  const close = useAuthPrompt((s) => s.close);
  const succeed = useAuthPrompt((s) => s.succeed);
  const prepareGoogleSignIn = useAuthStore((s) => s.prepareGoogleSignIn);
  const applyPreparedSession = useAuthStore((s) => s.applyPreparedSession);

  const [step, setStep] = useState<Step>('choose');
  const [idToken, setIdToken] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);

  const focusableElements = useCallback(() => {
    const modal = modalRef.current;
    if (!modal) return [];
    return Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true',
    );
  }, []);

  const focusFirst = useCallback(() => {
    const elements = focusableElements();
    (elements[0] ?? modalRef.current)?.focus();
  }, [focusableElements]);

  const focusLast = useCallback(() => {
    const elements = focusableElements();
    (elements[elements.length - 1] ?? modalRef.current)?.focus();
  }, [focusableElements]);

  // A modal owns focus and makes every app surface behind it non-interactive. Preserve each
  // sibling's prior inert state so nested/future overlays are not accidentally re-enabled, then
  // return focus to the control that opened the dialog once the exit animation unmounts it.
  useLayoutEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backdrop = backdropRef.current;
    const root = backdrop?.parentElement;
    const background = root
      ? Array.from(root.children).filter(
          (element): element is HTMLElement => element instanceof HTMLElement && element !== backdrop,
        )
      : [];
    const previousInert = background.map((element) => ({ element, inert: element.inert }));
    for (const element of background) element.inert = true;
    closeRef.current?.focus();

    return () => {
      for (const { element, inert } of previousInert) element.inert = inert;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!busy) close();
        return;
      }
      if (e.key !== 'Tab') return;

      const modal = modalRef.current;
      const elements = focusableElements();
      if (!modal || elements.length === 0) {
        e.preventDefault();
        modal?.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !modal.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, close, focusableElements]);

  useEffect(() => {
    if (step === 'username') usernameRef.current?.focus();
  }, [step]);

  const completeSignIn = useCallback(
    (session: PreparedAuthSession) => {
      runAuthSceneTransition('sign-in', () => {
        applyPreparedSession(session);
        succeed();
      });
    },
    [applyPreparedSession, succeed],
  );

  const onCredential = useCallback(
    async (token: string) => {
      setError(null);
      setBusy(true);
      try {
        const session = await prepareGoogleSignIn(token);
        completeSignIn(session);
      } catch (e) {
        if (e instanceof UsernameRequiredError) {
          setIdToken(token);
          setStep('username');
        } else {
          setError(e instanceof Error ? e.message : 'Sign-in failed. Please try again.');
        }
        setBusy(false);
      }
    },
    [completeSignIn, prepareGoogleSignIn],
  );

  const submitUsername = useCallback(async () => {
    const name = username.trim();
    if (!idToken || !name || busy) return;
    setError(null);
    setBusy(true);
    try {
      const session = await prepareGoogleSignIn(idToken, name);
      completeSignIn(session);
    } catch (e) {
      if (e instanceof UsernameConflictError) setError('That username is already taken — try another.');
      else if (e instanceof UsernameRequiredError) setError('Please enter a username.');
      else setError(e instanceof Error ? e.message : 'Sign-in failed. Please try again.');
      setBusy(false);
    }
  }, [idToken, username, busy, completeSignIn, prepareGoogleSignIn]);

  return (
    <motion.div
      ref={backdropRef}
      className="auth-backdrop"
      onMouseDown={(e) => {
        if (!busy && e.target === e.currentTarget) close();
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
    >
      <div className="auth-focus-guard" tabIndex={0} onFocus={focusLast} />
      <motion.div
        ref={modalRef}
        className="auth-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        tabIndex={-1}
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 8, scale: 0.98 }}
        transition={springGentle}
      >
        <button ref={closeRef} type="button" className="icon-btn auth-modal-close" aria-label="Close" onClick={close} disabled={busy}>
          <CloseIcon />
        </button>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step}
            initial={{ opacity: 0, x: step === 'username' ? 20 : -10 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: step === 'username' ? -20 : 10 }}
            transition={springSmooth}
          >
            {step === 'choose' ? (
              <>
                <div className="auth-modal-head">
                  <div className="auth-modal-mark" aria-hidden="true">
                    <BrandMark />
                  </div>
                  <h2 id="auth-modal-title" className="auth-modal-title">
                    Sign in to keep your work
                  </h2>
                  <p className="auth-modal-sub">
                    Browsing stays open to everyone — sign in only when you want to make something.
                  </p>
                </div>
                <ul className="auth-benefits">
                  {BENEFITS.map(({ Icon, text }) => (
                    <li key={text} className="auth-benefit">
                      <span className="auth-benefit-icon" aria-hidden="true">
                        <Icon />
                      </span>
                      <span>{text}</span>
                    </li>
                  ))}
                </ul>
                <div className="auth-modal-actions">
                  {busy ? (
                    <div className="auth-modal-progress" role="status" aria-live="polite">
                      <BrandMark />
                      <span>Signing you in…</span>
                    </div>
                  ) : (
                    <GoogleSignInButton onCredential={onCredential} onError={setError} />
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="auth-modal-head">
                  <div className="auth-modal-mark" aria-hidden="true">
                    <BrandMark />
                  </div>
                  <h2 id="auth-modal-title" className="auth-modal-title">
                    One last step
                  </h2>
                  <p className="auth-modal-sub">
                    Pick a username — this is how you’ll appear on the scores you publish. Your
                    account is created when you continue.
                  </p>
                </div>
                <form
                  className="auth-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submitUsername();
                  }}
                >
                  <label className="auth-field-label" htmlFor="auth-username">
                    Username
                  </label>
                  <input
                    ref={usernameRef}
                    id="auth-username"
                    className="auth-field"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="e.g. claranova"
                    maxLength={64}
                    autoComplete="username"
                  />
                  <Button variant="primary" type="submit" disabled={busy || !username.trim()}>
                    {busy ? 'Creating your account…' : 'Continue'}
                  </Button>
                </form>
              </>
            )}

            {error && (
              <p className="auth-modal-error" role="alert">
                {error}
              </p>
            )}
          </motion.div>
        </AnimatePresence>
      </motion.div>
      <div className="auth-focus-guard" tabIndex={0} onFocus={focusFirst} />
    </motion.div>
  );
}
