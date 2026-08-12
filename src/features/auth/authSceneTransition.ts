import { flushSync } from 'react-dom';
import { animate, type AnimationPlaybackControls } from 'motion/react';
import { create } from 'zustand';
import { springGentle, springSnappy } from '@/styles/motion';

export type AuthSceneTransitionKind = 'sign-in' | 'sign-out';
interface SceneAnimation extends AnimationPlaybackControls {
  then(onResolve: VoidFunction, onReject?: VoidFunction): Promise<void>;
}

interface AuthSceneTransitionState {
  kind: AuthSceneTransitionKind | null;
}

const useAuthSceneTransitionStore = create<AuthSceneTransitionState>(() => ({ kind: null }));

/** AppShell uses this only to suppress its ordinary route crossfade while the auth scene owns the
 *  same change. One visual change must have one driver. */
export function useAuthSceneTransitionActive(): boolean {
  return useAuthSceneTransitionStore((state) => state.kind !== null);
}

interface FrozenLayer {
  element: HTMLDivElement;
  rect: DOMRect;
}

let generation = 0;
let activeLayers: HTMLDivElement[] = [];
let activeAnimations: SceneAnimation[] = [];

function stripInteractiveState(clone: HTMLElement): void {
  clone.removeAttribute('id');
  for (const element of clone.querySelectorAll<HTMLElement>('[id]')) element.removeAttribute('id');
  for (const element of clone.querySelectorAll<HTMLElement>('[autofocus], [tabindex]')) {
    element.removeAttribute('autofocus');
    element.tabIndex = -1;
  }

  // Never duplicate a cross-origin document. Successful sign-in replaces the GIS button with an
  // app-native progress row before this snapshot is taken; removal here is the defensive fallback.
  for (const iframe of clone.querySelectorAll('iframe')) iframe.remove();
}

function copyScrollPositions(source: HTMLElement, clone: HTMLElement): void {
  const sourceNodes = [source, ...source.querySelectorAll<HTMLElement>('*')];
  const cloneNodes = [clone, ...clone.querySelectorAll<HTMLElement>('*')];
  for (let index = 0; index < Math.min(sourceNodes.length, cloneNodes.length); index += 1) {
    cloneNodes[index].scrollTop = sourceNodes[index].scrollTop;
    cloneNodes[index].scrollLeft = sourceNodes[index].scrollLeft;
  }
}

function freeze(source: HTMLElement): FrozenLayer {
  const rect = source.getBoundingClientRect();
  const clone = source.cloneNode(true) as HTMLElement;
  stripInteractiveState(clone);

  const layer = document.createElement('div');
  layer.className = 'auth-scene-snapshot';
  layer.setAttribute('aria-hidden', 'true');
  layer.inert = true;
  Object.assign(layer.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  Object.assign(clone.style, {
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: '0',
    maxWidth: 'none',
    transform: 'none',
  });
  layer.appendChild(clone);
  document.body.appendChild(layer);
  copyScrollPositions(source, clone);
  activeLayers.push(layer);
  return { element: layer, rect };
}

function stopPreviousTransition(): void {
  generation += 1;
  for (const animation of activeAnimations) animation.stop();
  for (const layer of activeLayers) layer.remove();
  activeAnimations = [];
  activeLayers = [];
  document.body.removeAttribute('data-auth-scene');
  useAuthSceneTransitionStore.setState({ kind: null });
}

function settleTransition(currentGeneration: number, animations: SceneAnimation[]): void {
  void Promise.all(animations.map((animation) => animation.then(() => undefined, () => undefined))).then(() => {
    if (generation !== currentGeneration) return;
    for (const layer of activeLayers) layer.remove();
    activeLayers = [];
    activeAnimations = [];
    document.body.removeAttribute('data-auth-scene');
    useAuthSceneTransitionStore.setState({ kind: null });
  });
}

function modalOrigin(): { x: number; y: number } {
  const modal = document.querySelector<HTMLElement>('.auth-modal');
  const rect = modal?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) {
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

function runSignIn(update: () => void, reduceMotion: boolean): SceneAnimation[] {
  const root = document.getElementById('root');
  if (!root) {
    update();
    return [];
  }

  const origin = modalOrigin();
  const oldScene = freeze(root);
  oldScene.element.style.transformOrigin = `${origin.x - oldScene.rect.left}px ${origin.y - oldScene.rect.top}px`;

  flushSync(update);

  if (reduceMotion) {
    return [animate(oldScene.element, { opacity: [1, 0] }, springSnappy)];
  }

  return [
    animate(
      oldScene.element,
      {
        opacity: [1, 0.94, 0],
        scale: [1, 1.018, 1.065],
      },
      springGentle,
    ),
  ];
}

function runSignOut(update: () => void, reduceMotion: boolean): SceneAnimation[] {
  const content = document.querySelector<HTMLElement>('.app-shell-content');
  const account = document.querySelector<HTMLElement>('.app-nav-account-slot');
  if (!content) {
    update();
    return [];
  }

  const contentLayer = freeze(content);
  const accountLayer = account ? freeze(account) : null;

  // The true auth/navigation state commits now. One frozen profile surface remains above the
  // already-settled Explore route and gently recedes to reveal it; Explore itself never moves.
  flushSync(update);

  const animations = [
    animate(
      contentLayer.element,
      reduceMotion
        ? { opacity: [1, 0] }
        : {
            opacity: [1, 0.74, 0],
            y: [0, -5],
            scale: [1, 0.994, 0.98],
          },
      reduceMotion ? springSnappy : springGentle,
    ),
  ];

  if (accountLayer) {
    animations.push(
      animate(
        accountLayer.element,
        reduceMotion
          ? { opacity: [1, 0] }
          : {
              opacity: [1, 0.7, 0],
              scale: [1, 0.985, 0.96],
            },
        reduceMotion ? springSnappy : springGentle,
      ),
    );
  }
  return animations;
}

/** Runs the auth change as one scene transition. Sign-in is a camera move through the current
 *  modal/shell into the authenticated space. Sign-out keeps Explore stationary underneath while
 *  one frozen profile surface recedes above it. The DOM truth changes synchronously; only a
 *  disposable, inert snapshot lags behind for presentation. */
export function runAuthSceneTransition(kind: AuthSceneTransitionKind, update: () => void): void {
  stopPreviousTransition();
  const currentGeneration = generation;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.body.dataset.authScene = kind;
  useAuthSceneTransitionStore.setState({ kind });

  let animations: SceneAnimation[];
  try {
    animations = kind === 'sign-in' ? runSignIn(update, reduceMotion) : runSignOut(update, reduceMotion);
  } catch (error) {
    stopPreviousTransition();
    throw error;
  }
  activeAnimations = animations;

  if (animations.length === 0) {
    if (generation === currentGeneration) {
      document.body.removeAttribute('data-auth-scene');
      useAuthSceneTransitionStore.setState({ kind: null });
    }
    return;
  }
  settleTransition(currentGeneration, animations);
}
