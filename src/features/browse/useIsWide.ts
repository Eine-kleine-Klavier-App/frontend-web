import { useSyncExternalStore } from 'react';

/** The desktop breakpoint at which the right preview panel is a viable third column. Below it,
 *  selecting a piece uses the full-screen `/scores/:id` route instead (docs/browse-redesign.md,
 *  round 3). Kept in one place so AppShell (renders the panel) and the browse screens (decide
 *  panel-vs-route on card click) agree. */
export const PANEL_BREAKPOINT = 1080;

const query = `(min-width: ${PANEL_BREAKPOINT}px)`;

export function useIsWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', cb);
      return () => mql.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
    () => true,
  );
}
