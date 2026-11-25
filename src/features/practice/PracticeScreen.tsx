import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useTransform, type MotionStyle } from 'motion/react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useEditor } from '@/app/store';
import { useAuthStore } from '@/core/auth/authStore';
import { keyMarks, type KeyMark } from '@/core/keys/KeyMarks';
import { midiInput, useMidiState } from '@/core/midi/MidiInput';
import { beatAtTime, navigation, useNavigationValue } from '@/core/navigation/ScoreNavigation';
import { playback, usePlaybackValue } from '@/core/playback/PlaybackController';
import { practice, usePractice } from '@/core/practice/PracticeSession';
import { EditorDocumentActions } from '@/features/editor/EditorDocumentActions';
import { HelpPopover } from '@/features/editor/HelpPopover';
import { ViewTabs, type ScreenView } from '@/features/editor/ViewTabs';
import { Transport, type TransportScrub } from '@/features/playback/Transport';
import { WaterfallStage, type WaterfallSky } from '@/features/playback/waterfall/WaterfallStage';
import { settleMotion, useSidePanelMotion } from '@/styles/motion';
import { AlertIcon, CloseIcon, CollapsePanelIcon } from '@/ui/icons';
import { LightSwitch } from '@/ui/LightSwitch';
import { PanelToolbar, PanelToolbarControl } from '@/ui/PanelToolbar';
import { readCssToken } from '@/ui/cssToken';
import { usePageReady } from '@/ui/PageTransition';
import { useMediaQuery } from '@/ui/useMediaQuery';
import { keyboardNote, PracticeRailBody, type StripSettings } from './PracticeRail';
import { PracticeStrip } from './PracticeStrip';
import { KEYS_HEIGHT_OF_WIDTH, zoneLayout } from './zoneLayout';
import './practice.css';

const STAGE_SKY: WaterfallSky = 'black';
/** The keys are the waterfall's own stage drawn this much taller than its width, of which only the lower part, the keyboard, is shown: it keeps its own proportions. */
const STAGE_OF_WIDTH = 1.05;

/** What moves the position in the practice, for the transport and for the dragged line alike. A step goes on in the sound player while the playback listens;
 *  otherwise the line the keyboard is waited at is put at the place of the score the music reaches first (only the listening has the passes).
 *  A line or a scrub taken by hand leaves the listening first: the sound held for it would be taken as a stop and the line taken back.
 *  A listening that was playing goes on from where the hand lets go, as on the other screens; a paused one stays stopped. */
function usePositionMover(): { seekMs: (ms: number) => void; scrub: TransportScrub } {
  const listening = usePractice().phase === 'listening';
  const map = useNavigationValue((value) => value.map);
  // kept apart from the memo below: leaving the listening changes it while the hand still holds the line
  const resume = useRef(false);
  return useMemo(() => {
    const place = (ms: number) => {
      if (map) practice.seek(beatAtTime(map, ms));
    };
    return {
      seekMs: (ms: number) => {
        if (listening) playback.seekMs(ms);
        else place(ms);
      },
      scrub: {
        begin: () => {
          navigation.update({ held: true });
          const sound = playback.getState();
          resume.current = listening && (sound.playing || sound.loading);
          if (listening) practice.stopListening();
        },
        to: place,
        end: () => {
          navigation.update({ held: false });
          if (!resume.current) return;
          resume.current = false;
          practice.listen();
        },
      },
    };
  }, [listening, map]);
}

/** The transport in the middle of the bar, the one the other views have. Play listens to the score from the line (the practice waits and takes the line back when it stops); the slider moves the line the keyboard is waited at. */
function PracticePill() {
  const state = usePractice();
  const listening = state.phase === 'listening';
  const playing = usePlaybackValue((value) => value.playing);
  const loading = usePlaybackValue((value) => value.loading);
  const paused = usePlaybackValue((value) => value.paused);
  const { seekMs, scrub } = usePositionMover();
  return (
    <Transport
      loading={listening && loading}
      playing={listening && playing}
      paused={listening && paused}
      disabled={state.phase === 'idle'}
      stopDisabled={state.phase === 'idle'}
      onPlay={() => (listening ? void playback.play() : practice.listen())}
      onPause={() => playback.pause()}
      onStop={() => (listening ? practice.stopListening() : practice.seek(0))}
      onSeekMs={seekMs}
      scrub={scrub}
    />
  );
}

export default function PracticeScreen() {
  const { scoreId } = useParams<{ scoreId: string }>();
  const reduce = useReducedMotion();
  const navigate = useNavigate();
  const location = useLocation();
  const userId = useAuthStore((state) => state.userId);
  const loadSource = useEditor((state) => state.loadSource);
  const clearSource = useEditor((state) => state.clearSource);
  const source = useEditor((state) => state.source);
  const document = useEditor((state) => state.document);
  const documentLoading = useEditor((state) => state.loading);
  const editError = useEditor((state) => state.error);
  const map = useNavigationValue((state) => state.map);
  const state = usePractice();
  const mover = usePositionMover();
  const midi = useMidiState();

  const [dismissed, setDismissed] = useState<string | null>(null);
  const [strip, setStrip] = useState<StripSettings>({ lineAt: 0.1, pinHead: true });
  const [stripColor] = useState(() => readCssToken(globalThis.document.documentElement, '--waterfall-strip-default'));
  const [mistakeColour, setMistakeColour] = useState(() => readCssToken(globalThis.document.documentElement, '--color-danger'));

  // The keyboard drawing shows the keys to press as lit and the keys held as down; a held key that is not waited for is down in the mistake colour.
  // While the score listens nothing is waited for, so no held key is a mistake.
  useEffect(() => {
    const expected = state.phase === 'listening' ? [] : state.expected;
    const marks: KeyMark[] = expected
      .filter((pitch) => !state.pressed.includes(pitch))
      .map((pitch) => ({ pitch, shown: 'lit', colour: null }));
    for (const pitch of state.pressed) {
      marks.push({ pitch, shown: 'pressed', colour: expected.length > 0 && !expected.includes(pitch) ? mistakeColour : null });
    }
    keyMarks.set(marks);
  }, [state.pressed, state.expected, state.phase, mistakeColour]);
  useEffect(() => () => keyMarks.set([]), []);

  const documentReady = !documentLoading && document.id === scoreId && source?.id === scoreId && source.kind === 'saved';
  usePageReady(!!scoreId && (documentReady || !!editError));

  // The score, the playback plan and the keyboard belong to this screen while it is open.
  useLayoutEffect(() => {
    if (!scoreId) return;
    playback.bindScore(scoreId);
    void loadSource({ kind: 'saved', id: scoreId });
    return () => {
      practice.stop();
      playback.stop();
      clearSource();
      playback.bindDraft(null);
    };
  }, [scoreId, userId, loadSource, clearSource]);
  useEffect(() => {
    void midiInput.start();
    return () => midiInput.stop();
  }, []);
  useEffect(() => {
    if (documentReady) void playback.prepareMap();
  }, [documentReady, scoreId]);
  useEffect(() => {
    if (documentReady && map) practice.start();
  }, [documentReady, map]);

  // ---- the panel: the editor's own motion, so it opens and closes as it does there ----
  const wide = useMediaQuery('(min-width: 64.0625em)');
  const [railOpen, setRailOpen] = useState(wide);
  const railRef = useRef<HTMLElement>(null);
  const panelToggleRef = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLElement>(null);
  const { layout, visual } = useSidePanelMotion(railOpen);
  const railWidth = useMotionValue(0);
  const toggleWidth = useMotionValue(0);
  const toggleInset = useMotionValue(0);
  const toggleX = useTransform(() => Math.max(0, visual.get() * railWidth.get() - toggleWidth.get() - 2 * toggleInset.get()));
  const headerLeft = useTransform(() => {
    const progress = wide ? Math.max(0, Math.min(1, layout.get())) : 0;
    return progress * railWidth.get() + (1 - progress) * (toggleWidth.get() + toggleInset.get());
  });
  const headerOffset = useTransform(headerLeft, (value) => `${value}px`);
  const railX = useTransform(visual, (value) => `${(value - 1) * 100}%`);
  const rootRef = useRef<HTMLDivElement>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  const frameSpan = useMotionValue(0);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      railWidth.set(railRef.current?.offsetWidth ?? 0);
      toggleWidth.set(panelToggleRef.current?.offsetWidth ?? 0);
      toggleInset.set(panelToggleRef.current?.parentElement?.offsetLeft ?? 0);
      frameSpan.set(root.clientWidth);
      setFrameWidth(root.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    if (railRef.current) observer.observe(railRef.current);
    return () => observer.disconnect();
  }, [railWidth, toggleWidth, toggleInset, frameSpan]);
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (rail) {
      if (!railOpen && rail.contains(globalThis.document.activeElement)) panelToggleRef.current?.focus();
      rail.inert = !railOpen;
    }
    const drawer = !wide && railOpen;
    const bar = barRef.current;
    if (bar) {
      if (drawer && bar.contains(globalThis.document.activeElement)) panelToggleRef.current?.focus();
      bar.inert = drawer;
    }
  }, [railOpen, wide]);
  // Where the window is narrow the panel lies over the stage and a press outside closes it.
  useEffect(() => {
    if (wide || !railOpen) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!railRef.current?.contains(target) && !barRef.current?.contains(target) && !panelToggleRef.current?.contains(target)) setRailOpen(false);
    };
    globalThis.document.addEventListener('pointerdown', onDown);
    return () => globalThis.document.removeEventListener('pointerdown', onDown);
  }, [wide, railOpen]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '\\' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      setRailOpen((open) => !open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- the stage: always laid out for the whole window; the panel pushes it to the right, and what goes past the right edge is lost: the strip of notes is cut
  // sideways, the room above the keys is cut from the top, and the keyboard, which cannot be cut, is scaled evenly to the room that is left ----
  const stageRef = useRef<HTMLDivElement>(null);
  const stageShift = useTransform(() => wide ? Math.max(0, Math.min(1, layout.get())) * railWidth.get() : 0);
  const keysScale = useTransform(() => {
    const frame = frameSpan.get();
    return frame > 0 ? (frame - stageShift.get()) / frame : 1;
  });
  const [stageHeight, setStageHeight] = useState(0);
  useLayoutEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const measure = () => setStageHeight((previous) => previous === element.clientHeight ? previous : element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The keyboard drawing's height as a share of its width, measured while only the keys are shown. Its shape is fixed, so one share holds for every width.
  const fitRef = useRef<HTMLDivElement>(null);
  const [keysShare, setKeysShare] = useState(0);
  const keysHeight = (keysShare || KEYS_HEIGHT_OF_WIDTH) * frameWidth;
  const zones = zoneLayout({ width: frameWidth, height: stageHeight, keysHeight });
  const fitHeight = Math.max(zones.keysZone, STAGE_OF_WIDTH * frameWidth);
  useEffect(() => {
    if (!zones.keysShown) return;
    const canvas = fitRef.current?.querySelector<HTMLElement>('.waterfall-keyboard-canvas');
    if (!canvas) return;
    // The scene sizes the keyboard after layout, so its share is read again whenever it changes.
    const measure = () => {
      if (canvas.offsetWidth <= 1 || canvas.offsetHeight <= 1) return;
      const share = canvas.offsetHeight / canvas.offsetWidth;
      setKeysShare((previous) => Math.abs(previous - share) > 0.001 ? share : previous);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [zones.keysShown, frameWidth]);

  // The one toast slot of the workspace: what went wrong, or what the keyboard needs.
  const connected = midi.status === 'connected';
  const problem = state.problem ?? editError;
  const prompt = state.phase === 'lost' && !connected ? keyboardNote(midi) : null;
  const toast = problem ?? (prompt ? [prompt.text, prompt.hint].filter(Boolean).join(' ') : null);
  const shownToast = toast && toast !== dismissed ? toast : null;
  useEffect(() => { setDismissed(null); }, [toast]);

  return (
    <motion.div ref={rootRef} className={'app editor-screen is-reading practice-screen' + (railOpen ? '' : ' is-rail-closed')}>
      <motion.div className="editor-panel-control" style={{ x: toggleX }}>
        <PanelToolbarControl
          ref={panelToggleRef}
          className="panel-toggle"
          title={railOpen ? 'Hide panel (\\)' : 'Show panel (\\)'}
          aria-label={railOpen ? 'Hide panel' : 'Show panel'}
          aria-expanded={railOpen}
          aria-controls="practice-rail"
          onClick={() => setRailOpen((open) => !open)}
        ><CollapsePanelIcon /></PanelToolbarControl>
      </motion.div>
      <motion.header ref={barRef} className="editor-bar" style={{ left: headerLeft, '--header-left': headerOffset } as MotionStyle}>
        <EditorDocumentActions savedScoreId={scoreId} />
        <PracticePill />
        <div className="bar-history" role="group" aria-label="View controls">
          {!wide && <LightSwitch />}
          {/* the same tabs in the same place as on the other screens of the score; this one is the one that is on */}
          <ViewTabs
            value="practice"
            practice
            onChange={(view: ScreenView) => {
              if (view === 'practice' || !scoreId) return;
              navigate(`/scores/${encodeURIComponent(scoreId)}`, { state: { returnTo: (location.state as { returnTo?: string } | null)?.returnTo, view } });
            }}
          />
        </div>
      </motion.header>
      <motion.aside id="practice-rail" ref={railRef} className="rail editor-rail" aria-label="Practice" style={{ x: railX }}>
        <PanelToolbar label="Practice" className="editor-panel-toolbar" />
        <PracticeRailBody
          strip={strip}
          onStrip={(patch) => setStrip((current) => ({ ...current, ...patch }))}
          stripShown={zones.notesShown}
          mistakeColour={mistakeColour}
          onMistakeColour={setMistakeColour}
        />
        <div className="rail-foot">
          <HelpPopover topic="practice" />
          {wide && <LightSwitch />}
        </div>
      </motion.aside>
      <div ref={stageRef} className="practice-stage">
        <motion.div className="practice-stage-inner" style={{ x: stageShift }}>
        {frameWidth > 0 && zones.notesShown && (
          <div className="practice-notes" style={{ height: zones.notesZone }}>
            {documentReady && <PracticeStrip width={frameWidth} height={zones.notesZone} lineAt={strip.lineAt} pinHead={strip.pinHead} scrub={mover.scrub} />}
          </div>
        )}
        {frameWidth > 0 && zones.keysShown && (
          <div
            className="practice-keys"
            data-form="keys"
            style={{ height: zones.keysZone, '--sky-now': `var(--waterfall-sky-${STAGE_SKY})` } as React.CSSProperties}
          >
            <motion.div className="practice-fit" ref={fitRef} style={{ height: fitHeight, scale: keysScale, originX: 0, originY: 1 }}>
              <WaterfallStage
                sky={STAGE_SKY}
                active
                stripColor={stripColor}
                viewportRef={fitRef}
                octaveLines
                measureLines
                backgroundDust
              />
            </motion.div>
          </div>
        )}
        {state.phase === 'counting' && <div className="practice-count" role="status">{state.countIn}</div>}
        </motion.div>
      </div>
      <div className="editor-toast-anchor">
        <AnimatePresence>
          {shownToast && (
            <motion.div key={shownToast} className="editor-toast" role={problem ? 'alert' : 'status'} {...settleMotion(reduce)}>
              {problem && <AlertIcon />}<span>{shownToast}</span>
              <button type="button" className="icon-btn ghost" aria-label="Dismiss" onClick={() => setDismissed(shownToast)}><CloseIcon /></button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
