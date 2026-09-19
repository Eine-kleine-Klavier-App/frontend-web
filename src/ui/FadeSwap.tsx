import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useRef, type ReactNode } from 'react';
import { reducedFade, springSnappy } from '@/styles/motion';
import { usePageTransitionPhase } from '@/ui/PageTransition';

/** Crossfades between different states of the SAME content area — most commonly a loading
 *  placeholder swapping for real data once it arrives, so an async fetch resolving never hard-pops
 *  the content in with zero transition. Keyed by `stateKey` (e.g. `!data ? 'loading' : 'content'`)
 *  — pass a NEW key whenever the shown content materially changes.
 *
 *  `popLayout` removes the departing state from flow while the arriving state takes its final
 *  geometry immediately. During page death the last settled content is frozen; during page entry
 *  data may update immediately behind the parent animation without starting a second entrance. */
export function FadeSwap({ stateKey, children }: { stateKey: string; children: ReactNode }) {
  const pagePhase = usePageTransitionPhase();
  const reduce = useReducedMotion();
  const frozen = useRef({ stateKey, children });
  if (pagePhase !== 'exiting') frozen.current = { stateKey, children };

  const shown = pagePhase === 'exiting' ? frozen.current : { stateKey, children };
  const animateLocally = pagePhase === 'settled';

  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div
        key={shown.stateKey}
        initial={animateLocally ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        exit={{ opacity: animateLocally ? 0 : 1 }}
        transition={animateLocally ? (reduce ? reducedFade : springSnappy) : { duration: 0 }}
      >
        {shown.children}
      </motion.div>
    </AnimatePresence>
  );
}
