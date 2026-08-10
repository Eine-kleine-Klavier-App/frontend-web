import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';

export interface ScrollEdges {
  canScrollLeft: boolean;
  canScrollRight: boolean;
}

/** Tracks whether a horizontally-scrolling element actually has anywhere left to go in each
 *  direction — for hiding/disabling carousel arrows that would otherwise do nothing. Recomputes
 *  on THREE independent triggers so it stays correct without the caller remembering to
 *  invalidate anything:
 *   - `scroll` — the user (or a nudge click) moved the track.
 *   - `ResizeObserver` on the element itself — the viewport/track's own box width changed
 *     (window resize, panel opening next to it).
 *   - `MutationObserver` (childList, subtree) — the track's CONTENT changed (more cards appended
 *     — e.g. a future "load more"/pagination, or a track that only mounts once async data
 *     arrives — or removed), independent of any resize.
 *
 *  Returns a CALLBACK ref (attach via `ref={setTrack}`), not a plain object ref: React invokes a
 *  callback ref exactly when the node attaches/detaches, which is the only timing that's reliable
 *  for a track that may not exist on the caller's first render (e.g. gated behind an async
 *  fetch) — a plain `RefObject` gives no signal for attaching late, since reading `.current` from
 *  an effect can't distinguish "not mounted yet" from "mounted after this effect last ran".
 *  `trackRef` is exposed alongside for callers that also need imperative access (e.g. a nudge
 *  button calling `.scrollBy`). */
export function useScrollEdges<T extends HTMLElement>(): {
  setTrack: (node: T | null) => void;
  edges: ScrollEdges;
  trackRef: MutableRefObject<T | null>;
} {
  const [edges, setEdges] = useState<ScrollEdges>({ canScrollLeft: false, canScrollRight: false });
  const trackRef = useRef<T | null>(null);
  const [attachedTick, setAttachedTick] = useState(0);

  const setTrack = useCallback((node: T | null) => {
    trackRef.current = node;
    setAttachedTick((n) => n + 1);
  }, []);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const update = () => {
      const { scrollLeft, scrollWidth, clientWidth } = el;
      // a 1px tolerance absorbs subpixel rounding so the last px of scroll doesn't leave a
      // dead-looking-but-technically-still-enabled arrow.
      setEdges({
        canScrollLeft: scrollLeft > 1,
        canScrollRight: scrollLeft < scrollWidth - clientWidth - 1,
      });
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(el);
    const mutationObserver = new MutationObserver(update);
    mutationObserver.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener('scroll', update);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
    // `attachedTick` (not `trackRef`) is the dependency on purpose — a ref object's identity
    // never changes, so it can't drive a re-run; `setTrack` bumps this tick exactly when React
    // actually (re)attaches the node, which is what needs to re-arm the listeners below.
  }, [attachedTick]);

  return { setTrack, edges, trackRef };
}
