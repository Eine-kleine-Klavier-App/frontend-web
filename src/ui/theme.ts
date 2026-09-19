// Day/night. Theme = `data-theme` on <html> (set before first paint by the inline script in
// index.html, remembered in localStorage, `?theme=` still works).
//
// The switch motion — a circle of the new palette spreading from the switch (lengths in
// `THEME_SWITCH_MS`, styles/motion.ts):
//   tug    0–90ms    the switch is pulled 0.35rem down with resistance (y = depth·k²) while a black
//                    dim rises to 6% (opacity 0.06·k²);
//   click  90–230ms  a damped spring back (y = depth·e^(−6k)·cos(9k));
//   light  740ms     the new palette spreads as a circle from the switch's centre on
//                    cubic-bezier(0.2,0,0,1) with a feathered edge (34% of the max radius); the dim
//                    releases as 0.06·(1 − e).
//
// Mechanism — no View Transitions: Safari freezes ~150ms taking their snapshots (the tug stalls and
// the circle lands in one frame) and their overlay swallows pointer events. Instead a static copy of
// the OLD page covers the live one while the live page changes theme at the start. The old copy is
// masked away from the switch, revealing the new palette beneath it. The tug starts on the click's
// own frame; the copy is built on the next frame, and the light's clock starts once the tug is over AND the copy is
// there, with every frame's step capped, so a long frame is never spent unseen.
//
// Interrupt: ONE clock `k` (0 = nothing shown … 1 = fully open) and a direction. A click while the
// light spreads flips the direction, so the circle closes back into the switch from where it is; a
// click while it closes spreads it again. On each reversal the live page takes the requested theme
// immediately and the currently visible side is frozen in a replacement copy.
//
// Reduced motion: the same flow as a 150ms crossfade (no tug, no mask, no dim).
// Global CSS colour transitions are off for the switch's length (`theme-switching`).

import { THEME_SWITCH_EASE, THEME_SWITCH_MS } from '@/styles/motion';
import { readCssToken } from '@/ui/cssToken';

export type Theme = 'light' | 'dark';

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

// the backdrop behind the page, as the pre-paint script in index.html set it: the theme's
// --color-backdrop (read once `data-theme` names the theme)
function setBrowserTheme(theme: Theme) {
  const root = document.documentElement;
  root.style.colorScheme = theme;
  root.style.backgroundColor = readCssToken(root, '--color-backdrop');
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  setBrowserTheme(theme);
  try {
    window.localStorage.setItem('theme', theme);
  } catch {
    // storage blocked: the choice lives for this session only
  }
}

const { tug: TUG_MS, click: CLICK_MS, light: LIGHT_MS, fade: FADE_MS, icon: ICON_MS } = THEME_SWITCH_MS;
const EASE_LIGHT = THEME_SWITCH_EASE;
const DEPTH_REM = 0.35;
const DIM = 0.06;
// exactly k² (x runs linearly, y = 3·(1/3)·k²(1−k) + k³ = k²)
const EASE_SQUARE = 'cubic-bezier(0.333333, 0, 0.666667, 0.333333)';
const FEATHER = 0.34; // of the max radius
const MAX_STEP_MS = 34; // one frame's step at most: a stalled frame never skips the light

/** cubic-bezier(x1, y1, x2, y2) as a function of x */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  return (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const cx = 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3 - x;
      const dx = 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;
      if (Math.abs(dx) < 1e-6) break;
      t = Math.min(1, Math.max(0, t - cx / dx));
    }
    return 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  };
}
const easeLight = bezier(0.2, 0, 0, 1);

type Switch = {
  /** a click while it runs: flip the direction of the light */
  reverse: () => void;
  /** the frame loop has stopped (hidden tab): finish at once, forward */
  abandon: () => void;
  lastFrame: () => number;
};
let running: Switch | null = null;

/** The static copy of the page: every body child cloned under a wrapper that carries the chosen
 *  theme (tokens are scoped to `.theme-copy[data-theme]`). What the DOM does not carry in
 *  attributes — scroll offsets, form values — is copied by walking both trees in step. Returns the
 *  wrapper, the clone of `origin` and the scroll offsets to apply once the wrapper is in the
 *  document: a detached element has no layout, so an offset set on it is silently dropped. */
function buildCopy(
  next: Theme,
  origin: HTMLElement,
): { copy: HTMLElement; copyOrigin: HTMLElement | null; scrolls: { to: HTMLElement; top: number; left: number }[] } {
  const scrolls: { to: HTMLElement; top: number; left: number }[] = [];
  const copy = document.createElement('div');
  copy.className = 'theme-copy';
  copy.dataset.theme = next;
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  let copyOrigin: HTMLElement | null = null;
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (/^(SCRIPT|STYLE|LINK|NOSCRIPT)$/.test(child.tagName) || child.classList.contains('theme-dim') || child.classList.contains('theme-copy')) continue;
    const clone = child.cloneNode(true) as HTMLElement;
    const live = [child, ...Array.from(child.querySelectorAll<HTMLElement>('*'))];
    const cloned = [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('*'))];
    for (let i = 0; i < live.length; i++) {
      const from = live[i];
      const to = cloned[i];
      if (from === origin) copyOrigin = to;
      if (from.scrollTop || from.scrollLeft) scrolls.push({ to, top: from.scrollTop, left: from.scrollLeft });
      if (from instanceof HTMLCanvasElement && to instanceof HTMLCanvasElement) {
        // a cloned canvas is empty; a WebGL one also loses its pixels once presented, so it is asked to draw now
        from.dispatchEvent(new Event('snapshot'));
        to.getContext('2d')?.drawImage(from, 0, 0);
      } else if (from instanceof HTMLInputElement && to instanceof HTMLInputElement) {
        to.value = from.value;
        to.checked = from.checked;
      } else if (from instanceof HTMLTextAreaElement && to instanceof HTMLTextAreaElement) {
        to.value = from.value;
      }
    }
    copy.appendChild(clone);
  }
  return { copy, copyOrigin, scrolls };
}

export function toggleTheme(origin: HTMLElement, reduce: boolean): void {
  if (running) {
    if (performance.now() - running.lastFrame() > 500) running.abandon();
    else {
      running.reverse();
      return;
    }
  }

  const previous = currentTheme();
  const next: Theme = previous === 'dark' ? 'light' : 'dark';
  const root = document.documentElement;
  root.classList.add('theme-switching');
  // geometry is read once, here — nothing is measured while the switch runs
  const rem = parseFloat(getComputedStyle(root).fontSize);
  const depth = DEPTH_REM * rem;
  const box = origin.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const maxR = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const feather = FEATHER * maxR;
  const tugMs = reduce ? 0 : TUG_MS;
  const lightMs = reduce ? FADE_MS : LIGHT_MS;

  const dim = document.createElement('div');
  dim.className = 'theme-dim';
  document.body.appendChild(dim);

  // the click's own frame: the switch is pulled and the dim starts to rise — both compositor
  // animations, nothing is built before they exist
  const SAMPLES = 60;
  const tugKeyframes = Array.from({ length: SAMPLES + 1 }, (_, i) => {
    const t = (i / SAMPLES) * (TUG_MS + CLICK_MS);
    const ty =
      t < TUG_MS
        ? depth * (t / TUG_MS) ** 2
        : depth * Math.exp((-6 * (t - TUG_MS)) / CLICK_MS) * Math.cos((9 * (t - TUG_MS)) / CLICK_MS);
    return { transform: `translateY(${ty}px)` };
  });
  const tugOptions = { duration: TUG_MS + CLICK_MS, easing: 'linear' } as const;
  const tug = reduce ? null : origin.animate(tugKeyframes, tugOptions);
  const dimIn = reduce
    ? null
    : dim.animate([{ opacity: 0 }, { opacity: DIM }], { duration: TUG_MS, easing: EASE_SQUARE, fill: 'forwards' });

  let copy: HTMLElement | null = null;
  let copyOrigin: HTMLElement | null = null;
  let copyShowsNew = false;
  let k = 0;
  let dir: 1 | -1 = 1;
  let revealing = false;
  let tugEnd = 0;
  let last = 0;
  let lastFrame = performance.now();
  let stopped = false;
  let stopMirror = () => {};

  const setLight = (e: number) => {
    if (!copy) return;
    if (reduce) {
      copy.style.opacity = String(copyShowsNew ? e : 1 - e);
      return;
    }
    const r = e * maxR * (1 + FEATHER);
    const mask = copyShowsNew
      ? `radial-gradient(circle at ${x}px ${y}px, #000 ${Math.max(0, r - feather)}px, transparent ${r}px)`
      : `radial-gradient(circle at ${x}px ${y}px, transparent ${Math.max(0, r - feather)}px, #000 ${r}px)`;
    copy.style.setProperty('-webkit-mask-image', mask);
    copy.style.maskImage = mask;
    dim.style.opacity = String(DIM * (1 - e));
  };

  const mountCopy = (theme: Theme, showsNew: boolean) => {
    const built = buildCopy(theme, origin);
    document.body.insertBefore(built.copy, dim);
    for (const { to, top, left } of built.scrolls) {
      to.scrollTop = top;
      to.scrollLeft = left;
    }
    stopMirror();
    copy?.remove();
    copy = built.copy;
    copyOrigin = built.copyOrigin;
    copyShowsNew = showsNew;
    setLight(reduce ? k : easeLight(k));
    if (copyOrigin) {
      const target = copyOrigin;
      const mirror = (on: boolean) => (on ? target.setAttribute('data-hover', '') : target.removeAttribute('data-hover'));
      const enter = () => mirror(true);
      const leave = () => mirror(false);
      mirror(origin.matches(':hover'));
      origin.addEventListener('pointerenter', enter);
      origin.addEventListener('pointerleave', leave);
      stopMirror = () => {
        origin.removeEventListener('pointerenter', enter);
        origin.removeEventListener('pointerleave', leave);
      };
    }
  };

  const self: Switch = {
    reverse: () => {
      dir = dir === 1 ? -1 : 1;
      if (!revealing && dir === -1) {
        const shown = getComputedStyle(dim).opacity;
        dimIn?.cancel();
        dim.style.opacity = shown;
        finishBack();
      } else if (revealing) {
        // Freeze the currently visible palette, then switch the real page immediately. Safari
        // reads its chrome tint from the live edge, so waiting for the mask to close is too late.
        mountCopy(currentTheme(), dir === -1);
        applyTheme(dir === -1 ? previous : next);
      }
    },
    abandon: () => {
      if (!stopped) { if (dir === 1) finishForward(); else finishBack(); }
      copy?.remove();
      dim.remove();
    },
    lastFrame: () => lastFrame,
  };
  running = self;

  /** the switch is over and a click may start the next one at once; `theme-switching` stays only
   *  if that next one is already running */
  const release = () => {
    stopped = true;
    stopMirror();
    if (running === self) running = null;
  };

  /** the light is fully open: repaint the live page under it, then drop the copy a frame later */
  const finishForward = () => {
    release();
    applyTheme(next);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        copy?.remove();
        dim.remove();
        if (!running) root.classList.remove('theme-switching');
      }),
    );
  };

  /** the light closed back into the switch (or never started): the live page was never touched */
  const finishBack = () => {
    release();
    applyTheme(previous);
    const from = Number(getComputedStyle(dim).opacity);
    copy?.remove();
    if (!running) root.classList.remove('theme-switching');
    const out = dim.animate([{ opacity: from }, { opacity: 0 }], { duration: FADE_MS, easing: EASE_LIGHT });
    out.onfinish = () => dim.remove();
    out.oncancel = () => dim.remove();
  };

  const frame = (now: number) => {
    if (stopped) return;
    lastFrame = performance.now();
    const dt = Math.min(MAX_STEP_MS, last ? now - last : 0);
    last = now;
    if (!revealing && now >= tugEnd) {
      revealing = true;
      if (dimIn) {
        dimIn.cancel();
        dim.style.opacity = String(DIM);
      }
      if (!reduce && copyOrigin) {
        // the icons turn over in the copy as the light starts: the outgoing one rotates away and
        // fades, the incoming one fades in (the theme in scope already picked the final state)
        const outgoing = copyOrigin.querySelector(next === 'dark' ? '.ls-moon' : '.ls-sun');
        const incoming = copyOrigin.querySelector(next === 'dark' ? '.ls-sun' : '.ls-moon');
        const turn = { duration: ICON_MS, easing: EASE_LIGHT, fill: 'backwards' } as const;
        outgoing?.animate([{ opacity: 1, transform: 'rotate(0deg)' }, { opacity: 0, transform: 'rotate(90deg)' }], turn);
        incoming?.animate([{ opacity: 0 }, { opacity: 1 }], turn);
      }
    }
    if (revealing) {
      k = Math.min(1, Math.max(0, k + (dir * dt) / lightMs));
      setLight(reduce ? k : easeLight(k));
      if (k >= 1 && dir === 1) return finishForward();
      if (k <= 0 && dir === -1) return finishBack();
    }
    requestAnimationFrame(frame);
  };

  requestAnimationFrame((now) => {
    if (stopped) return;
    tugEnd = now + tugMs;
    mountCopy(previous, false);
    applyTheme(next);
    if (tug && copyOrigin) {
      // the copy's switch springs in step with the live one: the circle opens over it at once
      copyOrigin.animate(tugKeyframes, tugOptions).startTime = tug.startTime;
    }
    requestAnimationFrame(frame);
  });
}
