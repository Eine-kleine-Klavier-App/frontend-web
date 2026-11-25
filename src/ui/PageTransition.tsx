import {
  createContext, useCallback, useContext, useLayoutEffect, useRef, useState, useEffect,
  type ReactNode, type RefObject,
} from 'react';
import { useReducedMotion } from 'motion/react';
import { ARRIVE_MS, EASE_IN_OUT_CSS, LEAVE_MS, TRAVEL_REM } from '@/styles/motion';

export type PageTransitionPhase = 'entering' | 'settled' | 'exiting';

const PagePhase = createContext<PageTransitionPhase>('settled');
const ReportReady = createContext<(ready: boolean) => void>(() => {});
const LOADING_REVEAL_MS = 140;
const REDUCED_MS = 120;

export function usePageTransitionPhase(): PageTransitionPhase {
  return useContext(PagePhase);
}

/** A scene reports its first usable presentation, including an empty or error screen. */
export function usePageReady(ready: boolean): void {
  const report = useContext(ReportReady);
  useLayoutEffect(() => {
    report(ready);
    return () => report(false);
  }, [report, ready]);
}

export function PageReadinessScope({ phase, onReady, children }: {
  phase: PageTransitionPhase;
  onReady: (ready: boolean) => void;
  children: ReactNode;
}) {
  return (
    <PagePhase.Provider value={phase}>
      <ReportReady.Provider value={onReady}>{children}</ReportReady.Provider>
    </PagePhase.Provider>
  );
}

/** Interrupt an opacity animation at the pixel currently displayed. The browser
 * compositor can keep it moving while the destination lays itself out. */
export function fadeScreenOpacity(
  element: HTMLElement, opacity: number, reduce: boolean | null, onComplete?: () => void, instant = false, leaving = false,
  /** the way the player is going (1 forward, -1 back): the screen leaves against it and arrives along it; 0 moves nothing */
  direction: -1 | 0 | 1 = 0,
): (() => void) | undefined {
  const from = Number(getComputedStyle(element).opacity);
  if (instant || Math.abs(from - opacity) < 0.001) {
    element.style.opacity = String(opacity);
    onComplete?.();
    return;
  }
  const travel = reduce || !direction ? null : `translateX(${(leaving ? -direction : direction) * TRAVEL_REM}rem)`;
  const keyframes: Keyframe[] = leaving
    ? [{ opacity: from, ...(travel ? { transform: 'translateX(0)' } : {}) }, { opacity, ...(travel ? { transform: travel } : {}) }]
    : [{ opacity: from, ...(travel ? { transform: travel } : {}) }, { opacity, ...(travel ? { transform: 'translateX(0)' } : {}) }];
  const flight = element.animate(keyframes, {
    duration: reduce ? REDUCED_MS : leaving ? LEAVE_MS : ARRIVE_MS,
    easing: reduce ? 'linear' : EASE_IN_OUT_CSS,
    fill: 'forwards',
  });
  flight.onfinish = () => {
    element.style.opacity = String(opacity);
    flight.cancel();
    onComplete?.();
  };
  return () => {
    const current = getComputedStyle(element).opacity;
    flight.onfinish = null;
    element.style.opacity = current;
    flight.cancel();
  };
}

export function useScreenOpacity(
  ref: RefObject<HTMLElement>, opacity: number, onComplete?: () => void, instant = false, leaving = false, direction: -1 | 0 | 1 = 0,
): void {
  const reduce = useReducedMotion();
  const complete = useRef(onComplete);
  useLayoutEffect(() => { complete.current = onComplete; }, [onComplete]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element) return fadeScreenOpacity(element, opacity, reduce, () => complete.current?.(), instant, leaving, direction);
  }, [ref, opacity, reduce, instant, leaving, direction]);
}

export function TransitionLoading({ waiting, label = 'Loading…' }: { waiting: boolean; label?: string }) {
  const [shown, setShown] = useState(false);
  const [painted, setPainted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!waiting) { setShown(false); return; }
    const timer = window.setTimeout(() => setShown(true), LOADING_REVEAL_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);
  const visible = waiting && shown;
  useLayoutEffect(() => { if (visible) setPainted(true); }, [visible]);
  useScreenOpacity(ref, visible ? 1 : 0, () => { if (!visible) setPainted(false); });

  return (
    <div ref={ref} className="screen-transition-status" aria-hidden={!visible}>
      {painted && <div className="screen-transition-chip" role="status">
        <span className="screen-transition-dots" aria-hidden="true"><i /><i /><i /></span>
        <span>{label}</span>
      </div>}
    </div>
  );
}

type LayerRole = 'base' | 'pending' | 'reveal' | 'reverse';

function PageLayer({ sceneKey, requestKey, role, current, leaving, hold, direction, children, onReady, onFadeEnd, onLeft }: {
  sceneKey: string;
  requestKey: string;
  role: LayerRole;
  current: boolean;
  /** The base scene lifts away: another one is to come. */
  leaving: boolean;
  /** The scene that is to come waits for the base to be gone. */
  hold: boolean;
  /** The way the scene being brought up is going: forward (1), back (-1), or nowhere in particular (0). */
  direction: -1 | 0 | 1;
  children: ReactNode;
  onReady: (key: string, request: string, ready: boolean) => void;
  onFadeEnd: (key: string, request: string, shown: boolean) => void;
  onLeft: () => void;
}) {
  const parent = usePageTransitionPhase();
  const phase: PageTransitionPhase = parent === 'exiting' || !current
    ? 'exiting' : role === 'base' ? parent : 'entering';
  const report = useCallback((ready: boolean) => onReady(sceneKey, requestKey, ready), [onReady, sceneKey, requestKey]);
  const ref = useRef<HTMLDivElement>(null);
  const hidden = role !== 'base';
  // The previous plate stays interactive while it is the only visible scene.
  const interactive = !hidden && parent !== 'exiting';
  useLayoutEffect(() => { if (ref.current) ref.current.inert = !interactive; }, [interactive]);
  // A scene leaves first (it lifts away), and the one that comes arrives after it: the two fades never overlap.
  const target = role === 'base' ? (leaving ? 0 : 1) : role === 'reveal' ? (hold ? 0 : 1) : 0;
  useScreenOpacity(ref, target, () => {
    if (role === 'base') { if (leaving) onLeft(); }
    else if (role === 'reveal') { if (!hold) onFadeEnd(sceneKey, requestKey, true); }
    else if (role === 'reverse') onFadeEnd(sceneKey, requestKey, false);
  }, role === 'pending', target === 0 && role !== 'pending',
  // the scene that comes arrives along the way, the one that goes leaves against it; one that is taken back goes the way it came
  role === 'reverse' || (role === 'base' && !leaving) ? (-direction as -1 | 0 | 1) : direction);

  return (
    <PageReadinessScope phase={phase} onReady={report}>
      <div ref={ref} className="page-transition-layer" data-layer={role} aria-hidden={!interactive}>
        {children}
      </div>
    </PageReadinessScope>
  );
}

/** Mount the requested scene at its final size. Keep the last complete scene
 * underneath until the requested scene covers it. At most one layer is fading. */
export function PageTransition({
  transitionKey, requestKey = transitionKey, children, className = '', disabled = false, direction,
}: {
  transitionKey: string;
  requestKey?: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  /** Which way one scene goes to another: forward (1), back (-1), or none (0). The scenes move along it while they fade. */
  direction?: (from: string, to: string) => -1 | 0 | 1;
}) {
  const parent = usePageTransitionPhase();
  const [base, setBase] = useState(transitionKey);
  const [flight, setFlight] = useState<string | null>(null);
  const [baseLeft, setBaseLeft] = useState(false);
  const [ready, setReady] = useState<ReadonlyMap<string, string>>(() => new Map());
  const committed = useRef(new Map<string, { children: ReactNode; request: string }>());
  const onReady = useCallback((key: string, request: string, value: boolean) => {
    setReady(previous => {
      if ((previous.get(key) === request) === value) return previous;
      const next = new Map(previous);
      if (value) next.set(key, request);
      else next.delete(key);
      return next;
    });
  }, []);
  const displayed = disabled ? transitionKey : base;
  const top = disabled ? null : flight;
  const topRequest = top === null ? undefined : committed.current.get(top)?.request;
  const freezeCurrent = top === transitionKey && topRequest !== undefined && topRequest !== requestKey;
  const desiredReady = !freezeCurrent && ready.get(transitionKey) === requestKey;
  const waiting = displayed !== transitionKey;
  const current = useRef({ key: transitionKey, request: requestKey, ready: desiredReady });
  // A nested host is the readiness source for its containing browse scene.
  usePageReady(desiredReady && (!waiting || disabled));

  useLayoutEffect(() => {
    current.current = { key: transitionKey, request: requestKey, ready: desiredReady };
    const nodes = committed.current;
    if (!freezeCurrent) nodes.set(transitionKey, { children, request: requestKey });
    for (const key of nodes.keys()) {
      if (key !== transitionKey && key !== displayed && key !== top) nodes.delete(key);
    }
    if (disabled) {
      setBase(transitionKey);
      setFlight(null);
    } else if (waiting && desiredReady && !top) {
      if (parent === 'entering') setBase(transitionKey);
      else if (parent !== 'exiting') setFlight(transitionKey);
    }
  }, [transitionKey, requestKey, children, displayed, top, disabled, waiting, desiredReady, freezeCurrent, parent]);

  useLayoutEffect(() => { if (top === null) setBaseLeft(false); }, [top]);
  const onLeft = useCallback(() => setBaseLeft(true), []);
  const finish = useCallback((key: string, request: string, shown: boolean) => {
    const target = current.current;
    if (shown && target.key === key && target.request === request && target.ready) setBase(key);
    setFlight(previous => previous === key ? null : previous);
  }, []);

  const keys = Array.from(new Set([displayed, transitionKey, ...(top === null ? [] : [top])]));
  return (
    <div className={`page-transition-stage ${className}`}>
      {keys.map(key => {
        const isCurrent = key === transitionKey && !freezeCurrent;
        const role = key === displayed ? 'base' : key !== top ? 'pending'
          : key === transitionKey && desiredReady ? 'reveal' : 'reverse';
        return <PageLayer
          key={key}
          sceneKey={key}
          requestKey={isCurrent ? requestKey : committed.current.get(key)?.request ?? key}
          role={role}
          current={isCurrent}
          leaving={role === 'base' && top !== null && top === transitionKey && desiredReady}
          hold={!baseLeft}
          direction={top !== null && direction ? direction(displayed, transitionKey) : 0}
          onReady={onReady}
          onFadeEnd={finish}
          onLeft={onLeft}
        >
          {isCurrent ? children : committed.current.get(key)?.children}
        </PageLayer>;
      })}
      {parent === 'settled' && <TransitionLoading waiting={!disabled && waiting && !desiredReady} />}
    </div>
  );
}
