import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, PresenceContext, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { settleMotion } from '@/styles/motion';

export type PageTransitionPhase = 'entering' | 'settled' | 'exiting';

const PageTransitionContext = createContext<PageTransitionPhase>('settled');

function inheritedPhase(
  own: PageTransitionPhase,
  parent: PageTransitionPhase,
): PageTransitionPhase {
  if (own === 'exiting' || parent === 'exiting') return 'exiting';
  if (own === 'entering' || parent === 'entering') return 'entering';
  return 'settled';
}

function PageLayer({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  const reduce = useReducedMotion();
  const parentPhase = useContext(PageTransitionContext);
  // A layer mounted under `AnimatePresence initial={false}` (the first route of a direct load)
  // plays no entry animation, so `onAnimationComplete` never fires — it is settled from the start.
  const presence = useContext(PresenceContext);
  const [settled, setSettled] = useState(presence?.initial === false);

  // re-entering (present flips back to true) restarts the entry; the mount itself does not
  const wasPresent = useRef(present);
  useEffect(() => {
    if (present && !wasPresent.current) setSettled(false);
    wasPresent.current = present;
  }, [present]);

  const ownPhase: PageTransitionPhase = !present
    ? 'exiting'
    : settled
      ? 'settled'
      : 'entering';
  const phase = inheritedPhase(ownPhase, parentPhase);
  // concept A: the outgoing plate lifts off (120ms), the incoming one settles (springSettle) —
  // no blur, no horizontal stretch; reduced motion = a 120ms opacity crossfade
  const { initial, animate, exit } = settleMotion(reduce);

  return (
    <PageTransitionContext.Provider value={phase}>
      <motion.div
        className="page-transition-layer"
        initial={initial}
        animate={animate}
        exit={exit}
        style={{ zIndex: present ? 2 : 1, pointerEvents: present ? 'auto' : 'none' }}
        onAnimationStart={() => {
          if (present) setSettled(false);
        }}
        onAnimationComplete={() => {
          if (present) setSettled(true);
        }}
      >
        {children}
      </motion.div>
    </PageTransitionContext.Provider>
  );
}

/**
 * The default view lifecycle: both route trees mount in the navigation commit, so the arriving
 * view starts its data work immediately. Motion only controls presentation — the outgoing plate
 * lifts away while the arriving one settles onto the desk (concept A, `settleMotion`).
 * `disabled` lets a more specific owner (currently the auth scene) replace this default.
 */
export function PageTransition({
  transitionKey,
  children,
  className = '',
  disabled = false,
}: {
  transitionKey: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const parentPhase = useContext(PageTransitionContext);
  const stageClassName = `page-transition-stage${className ? ` ${className}` : ''}`;

  if (disabled) {
    return (
      <div className={stageClassName}>
        <PageTransitionContext.Provider value={parentPhase}>
          <div className="page-transition-layer">{children}</div>
        </PageTransitionContext.Provider>
      </div>
    );
  }

  return (
    <div className={stageClassName}>
      <AnimatePresence initial={false} mode="sync">
        <PageLayer key={transitionKey}>{children}</PageLayer>
      </AnimatePresence>
    </div>
  );
}

export function usePageTransitionPhase(): PageTransitionPhase {
  return useContext(PageTransitionContext);
}
