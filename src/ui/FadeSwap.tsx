import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { springSnappy } from '@/styles/motion';

/** Crossfades between different states of the SAME content area — most commonly a loading
 *  placeholder swapping for real data once it arrives, so an async fetch resolving never hard-pops
 *  the content in with zero transition. Keyed by `stateKey` (e.g. `!data ? 'loading' : 'content'`)
 *  — pass a NEW key whenever the shown content materially changes.
 *
 *  Unlike the route-level transition (AppShell), this does NOT position children absolutely —
 *  screen content has natural, variable, scrolling height, so a brief (`springSnappy`, small/
 *  fast per the shared preset table) sequential fade is used instead of an overlapping crossfade.
 *  A short gap here is a deliberate, minor exception to "never a blank frame" (DESIGN.md §3.5
 *  principle 5 already grants one for the mode-switch wipe) — the content genuinely isn't ready
 *  yet, so there is nothing to overlap with. */
export function FadeSwap({ stateKey, children }: { stateKey: string; children: ReactNode }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={stateKey} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={springSnappy}>
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
