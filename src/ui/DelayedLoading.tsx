import { usePresence } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';

const LOADING_REVEAL_MS = 140;

/** Avoids flashing loading copy for reads that settle inside a single navigation frame. The
 * placeholder still appears for a real wait, but a cached or microtask-fast read stays visually
 * covered by the route crossfade instead of briefly painting text between two complete screens.
 * A placeholder that is already leaving never reveals its text: it is still in the layout while it fades,
 * and text appearing in it would push the arriving content down until it is removed. */
export function DelayedLoading({ children, className = 'browse-loading' }: { children: ReactNode; className?: string }) {
  const [visible, setVisible] = useState(false);
  const [isPresent] = usePresence();

  useEffect(() => {
    if (!isPresent) return;
    const timer = window.setTimeout(() => setVisible(true), LOADING_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [isPresent]);

  return (
    <div className={className} aria-live="polite" aria-busy="true">
      {visible ? children : null}
    </div>
  );
}
