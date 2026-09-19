import { useEffect, useRef, type RefObject } from 'react';

/** Closes an open popover on a press outside its own elements. `press` is the event a press outside is read from. */
export function useDismiss(
  open: boolean,
  inside: RefObject<Element>[],
  close: () => void,
  press: 'pointerdown' | 'mousedown' = 'pointerdown',
): void {
  // the latest `close` and elements, without resubscribing on every render
  const latest = useRef({ inside, close });
  latest.current = { inside, close };
  useEffect(() => {
    if (!open) return;
    const onPress = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!latest.current.inside.some((ref) => ref.current?.contains(target))) latest.current.close();
    };
    document.addEventListener(press, onPress);
    return () => document.removeEventListener(press, onPress);
  }, [open, press]);
}
