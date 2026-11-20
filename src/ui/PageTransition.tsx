import {
  createContext, useCallback, useContext, useLayoutEffect, useRef, useState, useEffect,
  type ReactNode, type RefObject,
} from 'react';
import { useReducedMotion } from 'motion/react';

export type PageTransitionPhase = 'entering' | 'settled' | 'exiting';

const PagePhase = createContext<PageTransitionPhase>('settled');
const ReportReady = createContext<(ready: boolean) => void>(() => {});
const LOADING_REVEAL_MS = 140;
const REVEAL_MS = 160;
const REDUCED_MS = 120;
const REVEAL_EASE = 'cubic-bezier(0.25, 0.1, 0.25, 1)';

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
  element: HTMLElement, opacity: number, reduce: boolean | null, onComplete?: () => void, instant = false,
): (() => void) | undefined {
  const from = Number(getComputedStyle(element).opacity);
  if (instant || Math.abs(from - opacity) < 0.001) {
    element.style.opacity = String(opacity);
    onComplete?.();
    return;
  }
  const flight = element.animate([{ opacity: from }, { opacity }], {
    duration: reduce ? REDUCED_MS : REVEAL_MS,
    easing: reduce ? 'linear' : REVEAL_EASE,
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
  ref: RefObject<HTMLElement>, opacity: number, onComplete?: () => void, instant = false,
): void {
  const reduce = useReducedMotion();
  const complete = useRef(onComplete);
  useLayoutEffect(() => { complete.current = onComplete; }, [onComplete]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element) return fadeScreenOpacity(element, opacity, reduce, () => complete.current?.(), instant);
  }, [ref, opacity, reduce, instant]);
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

function PageLayer({ sceneKey, requestKey, role, current, children, onReady, onFadeEnd }: {
  sceneKey: string;
  requestKey: string;
  role: LayerRole;
  current: boolean;
  children: ReactNode;
  onReady: (key: string, request: string, ready: boolean) => void;
  onFadeEnd: (key: string, request: string, shown: boolean) => void;
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
  useScreenOpacity(ref, role === 'base' || role === 'reveal' ? 1 : 0, () => {
    if (role === 'reveal' || role === 'reverse') onFadeEnd(sceneKey, requestKey, role === 'reveal');
  }, role === 'base' || role === 'pending');

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
  transitionKey, requestKey = transitionKey, children, className = '', disabled = false,
}: {
  transitionKey: string;
  requestKey?: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const parent = usePageTransitionPhase();
  const [base, setBase] = useState(transitionKey);
  const [flight, setFlight] = useState<string | null>(null);
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
          onReady={onReady}
          onFadeEnd={finish}
        >
          {isCurrent ? children : committed.current.get(key)?.children}
        </PageLayer>;
      })}
      {parent === 'settled' && <TransitionLoading waiting={!disabled && waiting && !desiredReady} />}
    </div>
  );
}
