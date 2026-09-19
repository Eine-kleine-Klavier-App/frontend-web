import { useSyncExternalStore } from 'react';

/** Whether a CSS media query matches now, re-rendering when it flips. For structure that must
 *  differ by width (which component renders where), not for styling — that stays in CSS. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
