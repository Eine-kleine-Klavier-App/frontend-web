// Shared spring presets — the single source of truth for all state-driven motion (DESIGN.md §3.5).
// A component inlining its own stiffness/damping is the same review defect as a hardcoded hex.
//
// Why springs, not durations: macOS-grade smoothness comes from CONTINUITY, not from an easing
// curve. A spring is a physical value moving toward a goal; change the goal mid-flight (toggle
// again, reverse, spam a button) and it retargets from its CURRENT position AND velocity — never
// jumps, never restarts, never queues. Its "duration" emerges from distance, which is exactly why
// it feels physical. All three presets are tuned to settle with NO visible oscillation; any
// overshoot you see is real momentum from a fast interaction, never baked into the curve.
//
// Two shapes of the same config:
//   - `SPRING_*`      → `SpringOptions` for `useSpring(value, SPRING_*)`.
//   - `spring*`       → `Transition` for `<motion.x transition={spring*}>` and `animate(el, kf, spring*)`.

export const SPRING_SNAPPY = { stiffness: 480, damping: 44 } as const;
export const SPRING_SMOOTH = { stiffness: 280, damping: 34 } as const;
export const SPRING_GENTLE = { stiffness: 170, damping: 26 } as const;

/** small controls: chips, dots, handles, contextual-panel content. */
export const springSnappy = { type: 'spring', ...SPRING_SNAPPY } as const;
/** panels, containers, mode-switch curtain, module dock — the default for chrome. */
export const springSmooth = { type: 'spring', ...SPRING_SMOOTH } as const;
/** large surfaces, page-level moves. */
export const springGentle = { type: 'spring', ...SPRING_GENTLE } as const;

/** The day/night switch (`ui/theme.ts`): the pull on the switch, its spring back, the light's
 *  sweep, the reduced-motion crossfade and the icon's turn. A timed sequence, not a spring: the light
 *  is scrubbed frame by frame, so each phase has a fixed length. */
export const THEME_SWITCH_MS = { tug: 90, click: 140, light: 740, fade: 150, icon: 180 } as const;
/** the light's sweep and the icon's turn: the standard ease (`--ease-standard`) */
export const THEME_SWITCH_EASE = 'cubic-bezier(0.2, 0, 0, 1)';

/** Discrete search-prompt editing cadence. Temporal text is the browse shell's motion signature. */
export const SEARCH_PROMPT_ERASE_MS = 18;
export const SEARCH_PROMPT_TYPE_MS = 38;

// ---------------------------------------------------------------------------------------------
// Concept A — "Plates on a desk": the ONE motion idea, editor and browse alike. Everything that
// arrives SETTLES onto the surface (one near-critical spring: opacity in, a few px down, a hair of
// scale); everything that leaves LIFTS off it (a short ease-exit: fade + 4px up), about three
// times faster than the arrival. Pages, popovers, toasts, the inspector's content and the follow-
// scroll all use these; side panels share their quiet profile through `useSidePanelMotion`.

/** the arrival spring — near-critical (damping ≈ 2·√stiffness): it lands, it does not bounce */
export const SPRING_SETTLE = { stiffness: 380, damping: 39 } as const;
export const springSettle = { type: 'spring', ...SPRING_SETTLE } as const;
/** the exit — 120ms ease-exit, opacity + 4px up */
export const lift = { duration: 0.12, ease: [0.3, 0, 1, 1] } as const;
/** reduced motion: a settle collapses to this opacity crossfade; slides become instant */
export const reducedFade = { duration: 0.12, ease: 'linear' } as const;

/** Presence props for one settling surface. `fromY` is the offset it arrives from, in px: the
 *  default 8 starts it just below its rest (pages, the toast). A popover settles from its anchor —
 *  positive when the anchor is below it (opens upward), negative when the anchor is above. */
export function settleMotion(reduce: boolean | null, fromY = 8) {
  if (reduce) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1, transition: reducedFade },
      exit: { opacity: 0, transition: reducedFade },
    };
  }
  return {
    initial: { opacity: 0, y: fromY, scale: 0.985 },
    animate: { opacity: 1, y: 0, scale: 1, transition: springSettle },
    exit: { opacity: 0, y: -4, transition: lift },
  };
}

/** `settleMotion` for a GLASS surface. Opacity below 1 on any ancestor of `.glass-lens` cuts its
 *  backdrop off (the lens would show unblurred, then pop to glass at the end), so the surface
 *  only moves (`surface`: y + scale) and each glass layer fades itself (`layer`). */
export function glassSettleMotion(reduce: boolean | null, fromY = 8) {
  const fade = reduce ? reducedFade : springSettle;
  return {
    surface: reduce
      ? {}
      : {
          initial: { y: fromY, scale: 0.985 },
          animate: { y: 0, scale: 1, transition: springSettle },
          exit: { y: -4, transition: lift },
        },
    layer: {
      initial: { opacity: 0 },
      animate: { opacity: 1, transition: fade },
      exit: { opacity: 0, transition: reduce ? reducedFade : lift },
    },
  };
}

/** Scrolls `el` to the target with the settle spring instead of the browser's own smooth-scroll
 *  curve (one motion character). Instant under reduced motion. Returns a stop function. */
export function springScrollTo(
  el: HTMLElement,
  target: { top?: number; left?: number },
  reduce: boolean | null,
): () => void {
  const fromTop = el.scrollTop;
  const fromLeft = el.scrollLeft;
  const toTop = target.top ?? fromTop;
  const toLeft = target.left ?? fromLeft;
  if (reduce) {
    el.scrollTop = toTop;
    el.scrollLeft = toLeft;
    return () => {};
  }
  const controls = animate(0, 1, {
    ...springSettle,
    onUpdate: (t) => {
      el.scrollTop = fromTop + (toTop - fromTop) * t;
      el.scrollLeft = fromLeft + (toLeft - fromLeft) * t;
    },
  });
  return () => controls.stop();
}

/** The panel show/hide `visual` bounce (§3.5's panel case) — visibly underdamped
 * (ζ ≈ 0.6, deliberately more so than `SPRING_SNAPPY`'s ζ ≈ 1.0) so the macOS-style "kicks right
 * before sliding left / grows past open before settling back" character actually reads; moved
 * here so every spring config lives in the one place §11 requires. */
export const SPRING_PANEL_BOUNCE = { stiffness: 220, damping: 18 } as const;
/** Transition-shaped wrapper of `SPRING_PANEL_BOUNCE`, for `motion.div`'s declarative `transition`
 *  prop (the `SPRING_*` form is `SpringOptions`, for `useSpring`/imperative `animate()`; this is
 *  the `spring*` form, matching the naming split above). Reused by any panel/surface that wants
 *  the panels' macOS-window "bounce" character WITHOUT the full `useLayoutSafeSpring` machinery —
 *  that machinery exists specifically for a bounce driving a layout-affecting `width` next to
 *  a sibling that must never be nudged by the overshoot; a panel that only animates its
 *  own `transform`/`opacity` (no sibling reflow hazard) can use this directly. Cross-surface parity
 *  for "panel show/hide" (DESIGN.md §3.5) — the editor's inspector and browse's PreviewPanel share
 *  this exact config rather than each picking their own feel. */
export const springPanelBounce = { type: 'spring', ...SPRING_PANEL_BOUNCE } as const;

// ---------------------------------------------------------------------------------------------
// useLayoutSafeSpring — THE pattern for "this element has a springy/bouncy open-close feel, and
// it sits next to something else in normal layout flow (a flex/grid sibling, centered content,
// anything that reflows off this element's box)." Use it any time that combination shows up —
// it's not specific to any one panel.
//
// The problem it solves: a single bouncy spring value can't safely drive BOTH the decorative feel
// AND a layout-affecting CSS property (width/height/flex-basis/grid-template-columns/...) at once
// — every bounce/overshoot/anticipation in that value reflows the sibling too, visibly pushing
// whatever's next to it in lockstep with the decoration. Clamping the SAME bouncy value to its
// resting bounds only band-aids the common case — an interrupted/retargeted spring can still
// momentarily inherit enough velocity to slip past a clamp before it's damped out.
//
// The fix is structural, not a clamp: run TWO INDEPENDENT spring animations toward the same
// open/closed target from the same intent.
//   - `layout` — CRITICALLY DAMPED (damping >= 2*sqrt(stiffness)): a spring at or above critical
//     damping is mathematically incapable of overshooting past its target, by construction, in
//     every case including interruption/retargeting — not just the common start-from-rest one.
//     This is the ONLY value allowed to drive a layout-affecting CSS property.
//   - `visual` — whatever spring you want (bouncy, given extra open/close velocity for a kick or
//     overshoot) — drives ONLY `transform`/`opacity` on an element that does not itself affect any
//     sibling's box (e.g. absolutely positioned, or already isolated from layout flow).
// A defensive `[0,1]` clamp still sits on `layout`'s consumer side as belt-and-braces, but it
// should never actually engage in normal operation — critical damping already guarantees it.
//
// INVARIANT: `layout` must reach its target AT LEAST AS FAST AS `visual`, ideally sooner. Critical
// damping removes overshoot but is inherently SLOWER to approach the target than an underdamped
// spring at the same stiffness — with similar stiffness on both, `layout` visibly finishes later
// and content keeps reflowing after the panel's own edge already looks settled. Default `layout`
// stiffness is set well above typical `visual` stiffness so it reliably leads; if you pass a
// custom `visualSpring`, also pass a `layoutSpring` with meaningfully higher stiffness.
// ---------------------------------------------------------------------------------------------

import { useEffect, useRef } from 'react';
import { animate, useMotionValue, useReducedMotion } from 'motion/react';
import type { MotionValue } from 'motion/react';

export interface LayoutSafeSpringOptions {
  /** must be critically damped or higher (damping ≥ 2·√stiffness) — the default already is. */
  layoutSpring?: { stiffness: number; damping: number };
  /** may freely overshoot/oscillate. */
  visualSpring?: { stiffness: number; damping: number };
  /** decorative initial velocity injected into `visual` (never `layout`) when the target becomes
   *  open — e.g. a small overshoot-past-target-then-settle on arrival. */
  openVelocity?: number;
  /** decorative initial velocity injected into `visual` (never `layout`) when the target becomes
   *  closed — e.g. a small anticipation kick the opposite way before departing. */
  closeVelocity?: number;
}

function criticalDamping(stiffness: number): number {
  return Math.ceil(2 * Math.sqrt(stiffness)) + 2; // +2 margin past the exact critical point
}

// Deliberately much stiffer than any of the `spring*` presets above (see the INVARIANT note) —
// this is an invisible mechanism, not a decoration, so it should always resolve well before
// whatever visual flourish is happening next to it, never lag behind it.
const DEFAULT_LAYOUT_SPRING = { stiffness: 900, damping: criticalDamping(900) };

/** Returns two motion values, both animating 0 (closed) → 1 (open) or back, from independent
 *  spring animations sharing the same `open` intent. See the module doc above for which one is
 *  safe to use where. */
export function useLayoutSafeSpring(
  open: boolean,
  options: LayoutSafeSpringOptions = {},
): { layout: MotionValue<number>; visual: MotionValue<number> } {
  const reduce = useReducedMotion();
  const layout = useMotionValue(open ? 1 : 0);
  const visual = useMotionValue(open ? 1 : 0);
  const layoutSpring = options.layoutSpring ?? DEFAULT_LAYOUT_SPRING;
  const visualSpring = options.visualSpring ?? SPRING_SMOOTH;
  const openVelocity = options.openVelocity ?? 0;
  const closeVelocity = options.closeVelocity ?? 0;
  // Only animate when `open` actually CHANGED since last run, not merely "did the effect fire" —
  // an injected velocity makes a spring visibly move even when start === target, so a plain
  // "skip the first run" ref isn't enough (StrictMode double-invokes mount effects with the same
  // `open` both times, so a first-run-only flag is already spent by the second). Comparing
  // against the LAST `open` value survives that: only a genuine change animates.
  const lastOpenRef = useRef<boolean | null>(null);

  useEffect(() => {
    const target = open ? 1 : 0;
    const changed = lastOpenRef.current !== null && lastOpenRef.current !== open;
    lastOpenRef.current = open;
    if (reduce || !changed) {
      layout.jump(target);
      visual.jump(target);
      return;
    }
    const layoutControls = animate(layout, target, { type: 'spring', ...layoutSpring });
    const visualControls = animate(visual, target, {
      type: 'spring',
      ...visualSpring,
      velocity: open ? openVelocity : closeVelocity,
    });
    return () => {
      layoutControls.stop();
      visualControls.stop();
    };
    // `layout`/`visual` are stable MotionValue identities (from useMotionValue) — omitting them
    // from deps is intentional and correct, matching Motion's own useSpring/useTransform pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reduce, layoutSpring, visualSpring, openVelocity, closeVelocity]);

  return { layout, visual };
}


/** Left/right side panels share the preserved quiet profile with zero injected velocity.
 *  Its non-overshooting progress can safely carry both the slot and the fixed-width surface. */
export function useSidePanelMotion(open: boolean): { layout: MotionValue<number>; visual: MotionValue<number> } {
  const { visual } = useLayoutSafeSpring(open);
  return { layout: visual, visual };
}
