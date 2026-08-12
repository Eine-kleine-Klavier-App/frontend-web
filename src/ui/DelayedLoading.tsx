import { useEffect, useState, type ReactNode } from 'react';

const LOADING_REVEAL_MS = 140;

/** Avoids flashing loading copy for reads that settle inside a single navigation frame. The
 * placeholder still appears for a real wait, but a cached or microtask-fast read stays visually
 * covered by the route crossfade instead of briefly painting text between two complete screens. */
export function DelayedLoading({ children, className = 'browse-loading' }: { children: ReactNode; className?: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), LOADING_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className={className} aria-live="polite" aria-busy="true">
      {visible ? children : null}
    </div>
  );
}
