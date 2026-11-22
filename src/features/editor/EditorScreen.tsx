import { selectionInsertTool } from './selectionInsertTool';
import { UndoIcon, RedoIcon, AlertIcon, CloseIcon, LockIcon, CollapsePanelIcon } from '@/ui/icons';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useMotionValue, useReducedMotion, useTransform, type MotionStyle } from 'motion/react';
import { reducedFade, settleMotion, springSnappy, useSidePanelMotion } from '@/styles/motion';
import { ChoiceGroup } from '@/ui/ChoiceGroup';
import { useParams } from 'react-router-dom';
import { useAuthStore } from '@/core/auth/authStore';
import { PanelToolbar, PanelToolbarControl } from '@/ui/PanelToolbar';
import { EditorDocumentActions } from './EditorDocumentActions';
import { useEditor, hotbarSlotKey, HOTBAR_SLOT_COUNT } from '@/app/store';
import { Toolbar } from '@/features/editor/Toolbar';
import { EditorView } from '@/features/editor/EditorView';
import { SelectionInfo } from './SelectionInfo';
import { PropertiesPanel } from '@/features/editor/PropertiesPanel';
import { ListeningControls } from '@/features/playback/ListeningControls';
import { PlaybackBar } from '@/features/playback/PlaybackBar';
import { WaterfallStage, type WaterfallSky } from '@/features/playback/waterfall/WaterfallStage';
import { readCssToken } from '@/ui/cssToken';
import { WaterfallPanel } from '@/features/playback/waterfall/WaterfallPanel';
import { playback, usePlaybackValue } from '@/core/playback/PlaybackController';
import { measureBeats } from '@/core/model/contexts';
import { bindEditorAudition } from './EditorAudition';
import { HelpPopover } from '@/features/editor/HelpPopover';
import { ContextStrip } from './ContextStrip';
import { PitchModeNotice } from './PitchModeNotice';
import { HotPanel } from '@/features/editor/HotPanel';
import { parseTool } from '@/core/model/insertItems';
import { parseMark } from '@/core/model/markTools';
import { LightSwitch } from '@/ui/LightSwitch';
import { useMediaQuery } from '@/ui/useMediaQuery';
import { fadeScreenOpacity, TransitionLoading, usePageReady, usePageTransitionPhase } from '@/ui/PageTransition';
import type { ScoreDocument } from '@/core/model/score';
import {
  locate,
  carrierIdOf,
  itemOf,
  chordNoteIds,
  orderedVoiceNavigationIds,
  physicalNoteOrder,
} from '@/core/model/query';

type EditorView = 'editor' | 'waterfall';
const VIEW_OPTIONS: { value: EditorView; label: string }[] = [
  { value: 'editor', label: 'Score' },
  { value: 'waterfall', label: 'Waterfall' },
];
/** While the waterfall plays untouched, the bar leaves the roll alone after this long. */
const BAR_IDLE_MS = 3000;
/** how often the idle bar checks whether it should rest */
const BAR_IDLE_CHECK_MS = 500;

/** Arrow-key navigation's in-progress Shift-range state (EditorScreen's keydown handler).
 *  `scopeId` is the carrier id (note-mode) or voice id (carrier-mode) the range is confined
 *  to — carried through only to identify the scope, nothing reads it back apart from
 *  re-threading it. `ids` is the ordered id list it's ranging over (a chord's own notes, or a
 *  voice's carriers); `anchorId`/`cursorId` are the range's fixed/moving ends; `appliedIds` is
 *  exactly what we last set `selectedIds` to, so the NEXT Shift+Arrow can tell whether the
 *  store's selection still matches what we produced, or something else changed it in between
 *  (e.g. a mouse click) — in which case the range restarts fresh instead of extending a
 *  now-stale anchor. */
interface NavRange {
  kind: 'note' | 'carrier';
  scopeId: string;
  anchorId: string;
  cursorId: string;
  ids: string[];
  appliedIds: string[];
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

export default function EditorScreen() {
  // the route is the source of truth for which draft is open — this component doesn't own
  // that id, it just tells the store to load it (see App Router's `/edit/:draftId`).
  const { draftId, scoreId: savedScoreId } = useParams<{ draftId: string; scoreId: string }>();
  const activeId = draftId ?? savedScoreId;
  const userId = useAuthStore(state => state.userId);
  const reading = !!savedScoreId;
  const phase = usePageTransitionPhase();
  const ownsInput = phase === 'settled';
  const source = useEditor(state => state.source);
  const loadSource = useEditor(state => state.loadSource);
  const clearSource = useEditor(state => state.clearSource);
  const [documentTitle, setDocumentTitle] = useState<{ draftId: string; title: string } | null>(null);
  const onDocumentTitle = useCallback((title: string) => {
    if (!draftId) return;
    setDocumentTitle((previous) => previous?.draftId === draftId && previous.title === title ? previous : { draftId, title });
  }, [draftId]);
  const document = useEditor((s) => s.document);
  const editError = useEditor((s) => s.error);
  const playbackError = usePlaybackValue((state) => state.error);
  const playing = usePlaybackValue((state) => state.playing);
  const error = editError ?? playbackError;
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  useEffect(() => { setDismissedError(null); }, [error]);
  // what the document bar reports (a failed save, a missing working copy) shares the one toast slot with the editing error
  const [documentNotice, setDocumentNotice] = useState<string | null>(null);
  const shownError = error && error !== dismissedError ? error : null;
  const toastText = shownError ?? documentNotice;
  const dismissToast = () => {
    if (shownError) setDismissedError(shownError);
    setDocumentNotice(null);
  };
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const locked = useEditor((s) => s.locked);
  const pitchNotice = useEditor((s) => s.pitchNotice);
  const manualLocked = useEditor((s) => s.manualLocked);
  const playbackLocked = useEditor((s) => s.playbackLocked);
  const setLocked = useEditor((s) => s.setLocked);
  const setPlaybackLocked = useEditor((s) => s.setPlaybackLocked);
  const documentLoading = useEditor((s) => s.loading);
  const navRangeRef = useRef<NavRange | null>(null);
  const reduce = useReducedMotion();
  // a pick that no longer exists in the document (an undo removed it) is not a selection: the rail
  // keeps the tool panel rather than opening an inspector on nothing
  const hasSelection = useEditor(
    (s) =>
      s.selectedIds.some((id) => locate(s.document, id) !== null) ||
      s.document.measures.some((m) => s.selectedMeasureIds.includes(m.id)) ||
      s.selectedStructureIds.some((id) => [...s.document.beams, ...s.document.tuplets, ...s.document.ties, ...s.document.glissandos, ...s.document.contexts].some((o) => o.id === id)),
  );
  // Wide panels reserve room beside the score; narrow panels slide over it.
  const wide = useMediaQuery('(min-width: 64.0625em)');
  // The waterfall is a view of the desk. The left panel belongs to both views — the tools in the
  // editor, what the waterfall lets you set in the waterfall — and either view can hide it; the
  // bar is the same in both, so nothing in it moves when the view changes.
  const [view, setView] = useState<EditorView>('editor');
  const [requestedView, requestView] = useState<EditorView>('editor');
  const [paintedScore, setPaintedScore] = useState<ScoreDocument | null>(null);
  const [paintedWaterfall, setPaintedWaterfall] = useState(false);
  const onScorePaint = useCallback((ready: boolean) => {
    setPaintedScore(current => ready ? document : current === document ? null : current);
  }, [document]);
  const preparingView = requestedView !== view;
  const scorePainted = paintedScore === document;
  const documentReady = !documentLoading && document.id === activeId;
  const matchingSource = source?.id === activeId && source?.kind === (reading ? 'saved' : 'draft');
  usePageReady(matchingSource && !documentLoading && (!documentReady || scorePainted || !!editError));

  useLayoutEffect(() => {
    if (preparingView && (requestedView === 'waterfall' ? paintedWaterfall : scorePainted || !!editError)) {
      setView(requestedView);
    }
  }, [preparingView, requestedView, paintedWaterfall, scorePainted, editError]);
  const [panelOpen, setPanelOpen] = useState<Record<EditorView, boolean>>({ editor: wide, waterfall: false });
  const previousSavedScore = useRef(savedScoreId);
  useLayoutEffect(() => {
    if (previousSavedScore.current && draftId) {
      requestView('editor');
      setView('editor');
      setPanelOpen(open => ({ ...open, editor: wide }));
    }
    previousSavedScore.current = savedScoreId;
  }, [savedScoreId, draftId, wide]);
  const [sky, setSky] = useState<WaterfallSky>('black');
  const [stripColor, setStripColor] = useState(() => readCssToken(globalThis.document.documentElement, '--waterfall-strip-default'));
  const [tilt, setTilt] = useState(1);
  const [octaveLines, setOctaveLines] = useState(true);
  const [measureLines, setMeasureLines] = useState(true);
  const [backgroundDust, setBackgroundDust] = useState(true);
  const [barAwake, setBarAwake] = useState(true);
  const waterfall = view === 'waterfall';
  const scorePanelOpen = panelOpen.editor;
  const railOpen = view === 'editor' ? scorePanelOpen : panelOpen.waterfall;
  const railRef = useRef<HTMLElement>(null);
  const panelToggleRef = useRef<HTMLButtonElement>(null);
  const { layout, visual } = useSidePanelMotion(railOpen);
  // The outgoing score keeps its own reservation while the waterfall's panel moves.
  const { layout: editorLayout } = useSidePanelMotion(scorePanelOpen);
  const railWidth = useMotionValue(0);
  const toggleWidth = useMotionValue(0);
  const toggleInset = useMotionValue(0);
  const toggleX = useTransform(() => Math.max(0, visual.get() * railWidth.get() - toggleWidth.get() - 2 * toggleInset.get()));
  const [stageOnTop, setStageOnTop] = useState(false);
  const [deskCovered, setDeskCovered] = useState(false);
  const stageOnTopRef = useRef(false);
  const headerLeft = useTransform(() => {
    const progress = wide ? Math.max(0, Math.min(1, layout.get())) : 0;
    return progress * railWidth.get() + (1 - progress) * (toggleWidth.get() + toggleInset.get());
  });
  const headerOffset = useTransform(headerLeft, value => `${value}px`);
  const stageWidth = useMotionValue(1);
  const railX = useTransform(visual, (v) => `${(v - 1) * 100}%`);
  const layoutWidth = useTransform(() => `${wide ? Math.max(0, Math.min(1, layout.get())) * railWidth.get() : 0}px`);
  // Wide waterfall panels leave room for the stage without resizing its canvas.
  const pushed = waterfall && panelOpen.waterfall && wide;
  // Reveal an already painted layer over the current one. If the request
  // reverses mid-flight, fade from the opacity that is on screen.
  const deskRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const incoming = view === 'waterfall' ? stageRef.current : deskRef.current;
    const outgoing = view === 'waterfall' ? deskRef.current : stageRef.current;
    if (!incoming || !outgoing) return;
    setDeskCovered(false);
    const incomingOnTop = (view === 'waterfall') === stageOnTopRef.current;
    const putOnTop = () => {
      stageOnTopRef.current = view === 'waterfall';
      setStageOnTop(stageOnTopRef.current);
    };
    if (!incomingOnTop && Number(getComputedStyle(incoming).opacity) > 0.001) {
      return fadeScreenOpacity(outgoing, 0, reduce, () => {
        putOnTop();
        if (view === 'waterfall') setDeskCovered(true);
      });
    }
    if (!incomingOnTop) {
      putOnTop();
      outgoing.style.opacity = '1';
    }
    return fadeScreenOpacity(incoming, 1, reduce, () => {
      outgoing.style.opacity = '0';
      if (view === 'waterfall') setDeskCovered(true);
    });
  }, [view, reduce]);
  // the panel shows the contents of the view whose panel is open, so one that is sliding out keeps its own contents instead of turning into the other view's
  const railView = useRef<EditorView>(view);
  if (railOpen) railView.current = view;
  const stageScale = useTransform(() => 1 - (wide ? Math.max(0, Math.min(1, layout.get())) * railWidth.get() / stageWidth.get() : 0));
  // Prepare enough height for the fully open panel once; panel motion only reveals this reserve.
  const stageCanvasHeight = useTransform(() => {
    const width = stageWidth.get(), panel = railWidth.get();
    return wide && width > panel ? `${100 * width / (width - panel)}%` : '100%';
  });
  // Commit the engraving's new box once; carry its centre on the non-bouncing layout spring.
  const deskShift = useTransform(() => wide ? (Math.max(0, Math.min(1, editorLayout.get())) - (scorePanelOpen ? 1 : 0)) * railWidth.get() / 2 : 0);
  const barRef = useRef<HTMLElement>(null);
  const togglePanel = () => setPanelOpen((open) => ({ ...open, [view]: !open[view] }));
  const openLibrary = () => setPanelOpen((open) => ({ ...open, editor: true }));
  const closeLibrary = () => setPanelOpen((open) => ({ ...open, editor: false }));

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (rail) {
      if (!railOpen && rail.contains(window.document.activeElement)) panelToggleRef.current?.focus();
      rail.inert = !railOpen;
    }
    const drawer = !wide && railOpen;
    const bar = barRef.current;
    if (bar) {
      if (drawer && bar.contains(window.document.activeElement)) panelToggleRef.current?.focus();
      bar.inert = drawer;
    }
    if (deskRef.current) deskRef.current.inert = !ownsInput || waterfall || drawer;
    if (stageRef.current) stageRef.current.inert = !ownsInput || !waterfall || drawer;
  }, [ownsInput, railOpen, waterfall, wide]);

  useLayoutEffect(() => {
    const measure = () => {
      railWidth.set(railRef.current?.offsetWidth ?? 0);
      toggleWidth.set(panelToggleRef.current?.offsetWidth ?? 0);
      toggleInset.set(panelToggleRef.current?.parentElement?.offsetLeft ?? 0);
      stageWidth.set(stageRef.current?.offsetWidth || 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (railRef.current) observer.observe(railRef.current);
    if (stageRef.current) observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, [railWidth, stageWidth, toggleWidth, toggleInset]);

  useEffect(() => {
    if (wide || !railOpen) return;
    const close = () => setPanelOpen((open) => ({ ...open, [view]: false }));
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!railRef.current?.contains(target) && !barRef.current?.contains(target) && !panelToggleRef.current?.contains(target)) close();
    };
    window.document.addEventListener('pointerdown', onDown);
    return () => {
      window.document.removeEventListener('pointerdown', onDown);
    };
  }, [wide, railOpen, view]);

  useEffect(() => {
    if (!waterfall) { setBarAwake(true); return; }
    let last = performance.now();
    const wake = () => { last = performance.now(); setBarAwake(true); };
    const timer = window.setInterval(() => {
      const bar = barRef.current;
      if (!playing || performance.now() - last < BAR_IDLE_MS) return;
      if (bar?.matches(':hover') || bar?.querySelector(':focus-visible')) return;
      setBarAwake(false);
    }, BAR_IDLE_CHECK_MS);
    window.addEventListener('pointermove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, [waterfall, playing]);

  useEffect(() => {
    if (!ownsInput) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '\\' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      e.preventDefault();
      setPanelOpen((open) => ({ ...open, [view]: !open[view] }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ownsInput, view]);

  useLayoutEffect(() => {
    if (!activeId) return;
    if (savedScoreId) playback.bindScore(savedScoreId);
    else playback.bindDraft(draftId ?? null);
    void loadSource({ kind: savedScoreId ? 'saved' : 'draft', id: activeId });
    return () => { clearSource(); playback.bindDraft(null); };
  }, [activeId, draftId, savedScoreId, userId, loadSource, clearSource]);

  useEffect(() => {
    if (!activeId || !ownsInput) return;
    return bindEditorAudition();
  }, [activeId, ownsInput]);

  useEffect(() => {
    const sync = () => {
      const state = playback.getState();
      setPlaybackLocked(state.loading || state.playing || state.paused);
    };
    sync();
    const unsubscribe = playback.subscribe(sync);
    return () => { unsubscribe(); setPlaybackLocked(false); };
  }, [setPlaybackLocked]);

  useEffect(() => {
    if (!documentLoading && document.id === activeId) {
      playback.setTotalBeats(document.measures.reduce((total, measure) => total + measureBeats(measure.timeSignature), 0));
    }
  }, [document, documentLoading, activeId]);

  useLayoutEffect(() => {
    if (phase === 'exiting') playback.stop();
  }, [phase]);

  useEffect(() => {
    if (!ownsInput) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const s = useEditor.getState();
      if (s.pitchModeRequest) return;
      const meta = e.metaKey || e.ctrlKey;
      // `e.code` (physical key position, e.g. "KeyV") — not `e.key` (the character the active
      // keyboard LAYOUT produces for that key). Under a Cyrillic layout, `e.key` for the physical
      // V/Z keys is "м"/"я", not "v"/"z", so a `.key`-based check never fires — `.code` is
      // layout-independent for any QWERTY-derived physical layout.
      if (meta && !e.altKey && !e.shiftKey && e.code === 'KeyC') {
        if (s.loading || s.locked) return;
        const tool = selectionInsertTool(s.document, s);
        if (tool) { e.preventDefault(); s.setTool(tool); }
      } else if (meta && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) void s.redo();
        else void s.undo();
      } else if (!meta && !e.altKey && e.code === 'KeyV') {
        // the cursor/select tool's own fixed hotkey — it's not a hotbar slot (nothing to fill or
        // rearrange), so it isn't part of the 1-9/0 lookup below. NOT Escape: Escape is a
        // browser-TRUSTED key for exiting Fullscreen API mode — unblockable by design (a page can
        // never override it, precisely so it can't trap a user in fullscreen), so binding
        // anything to it also fires that native "collapse the window" behavior every time,
        // regardless of what our own handler does (real reported annoyance). `V` matches the
        // cursor/select-tool convention in Figma/Illustrator/Photoshop.
        e.preventDefault();
        s.setTool('select');
        s.select(null);
      } else if (!meta && !e.altKey && e.code === 'KeyL') {
        // the lock's own hotkey (layout-zones decision: `L` lock)
        e.preventDefault();
        if (s.source?.kind !== 'saved' && !s.playbackLocked) s.setLocked(!s.manualLocked);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (s.selectedIds.length || s.selectedStructureIds.length) {
          e.preventDefault();
          void s.deleteSelected();
        }
      } else if (!meta && !e.altKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (s.loading || s.locked || !s.selectedIds.length) return;
        e.preventDefault();
        navRangeRef.current = null;
        void s.shiftSelectedNotes(e.key === 'ArrowUp' ? 1 : -1);
      } else if (!meta && !e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // Two granularities, no extra endpoint — everything needed is already in the loaded
        // `document`. If the selection is ONE note out of a multi-note chord (not the whole
        // carrier), arrows step between that SAME chord's notes, bottom-to-top PHYSICALLY
        // (`physicalNoteOrder` — screen position, not pitch/spelling, which isn't implemented),
        // WRAPPING at the ends (top → bottom on ArrowRight past the last, and back). Once the
        // whole carrier is selected (stem-click/double-click, `carrierSelectedIds` — or a chord
        // with every one of its notes individually selected, which the codebase already treats as
        // equivalent, see [[note-vs-carrier-selection-granularity]]), arrows step between carriers
        // instead — that level does NOT wrap (past either end, nothing happens). `e.key`, not
        // `.code` — arrow keys aren't layout-remapped, unlike letters.
        const doc = s.document;
        const dir = e.key === 'ArrowRight' ? 1 : -1;

        if (!e.shiftKey) navRangeRef.current = null; // a plain move collapses any in-progress range

        // Derive the current single position + which granularity it's in — used both for a plain
        // move and for STARTING a new Shift-range. An in-progress Shift-range (below) skips this
        // and reuses its own stored anchor/cursor, since a multi-item range selection has no
        // single "current index" to re-derive from `selectedIds` alone.
        let mode: { kind: 'note' | 'carrier'; scopeId: string; ids: string[] } | null = null;
        let cursorId: string | null = null;
        if (s.selectedIds.length) {
          const anchorId = s.selectedIds[0];
          const carrierId = carrierIdOf(doc, anchorId);
          const item = itemOf(doc, carrierId);
          const selectedInCarrier = item ? item.notes.filter((n) => s.selectedIds.includes(n.noteId)) : [];
          if (item && item.notes.length > 1 && selectedInCarrier.length < item.notes.length) {
            mode = { kind: 'note', scopeId: carrierId, ids: physicalNoteOrder(doc, item) };
            cursorId = anchorId;
          } else {
            const voiceId = locate(doc, anchorId)?.voiceId;
            if (voiceId) {
              mode = { kind: 'carrier', scopeId: voiceId, ids: orderedVoiceNavigationIds(doc, voiceId) };
              cursorId = carrierId;
            }
          }
        } else {
          const voiceId = doc.voices[s.currentVoice]?.id;
          if (voiceId) mode = { kind: 'carrier', scopeId: voiceId, ids: orderedVoiceNavigationIds(doc, voiceId) };
        }

        // wrap for note-mode, clamp (no wrap) for carrier-mode — returns null past a carrier-mode edge
        const step = (kind: 'note' | 'carrier', ids: string[], fromIdx: number): number | null => {
          let next = fromIdx === -1 ? (dir === 1 ? 0 : ids.length - 1) : fromIdx + dir;
          if (kind === 'note') return ((next % ids.length) + ids.length) % ids.length;
          return next < 0 || next >= ids.length ? null : next;
        };
        const applySelection = (kind: 'note' | 'carrier', rangeIds: string[]): string[] => {
          if (kind === 'note') {
            s.selectMany(rangeIds, false);
            return rangeIds;
          }
          const noteIds = rangeIds.flatMap((cid) => chordNoteIds(doc, cid));
          s.selectMany(noteIds, false, rangeIds);
          return noteIds;
        };

        if (e.shiftKey) {
          const existing = navRangeRef.current;
          // reuse the in-progress range only if the store's selection still matches exactly what
          // WE last set it to — anything else in between (a mouse click) means the anchor is stale.
          const reusing = existing && sameIds(existing.appliedIds, s.selectedIds);
          const kind = reusing ? existing.kind : mode?.kind;
          const scopeId = reusing ? existing.scopeId : mode?.scopeId;
          const rangeItem = reusing && existing.kind === 'note' ? itemOf(doc, existing.scopeId) : null;
          const ids = reusing
            ? existing.kind === 'carrier' ? orderedVoiceNavigationIds(doc, existing.scopeId) : rangeItem ? physicalNoteOrder(doc, rangeItem) : []
            : mode?.ids;
          const anchorId = reusing ? existing.anchorId : cursorId;
          const fromId = reusing ? existing.cursorId : cursorId;
          if (!kind || !scopeId || !ids || !ids.length || anchorId == null || fromId == null) return;
          const fromIdx = ids.indexOf(fromId);
          const anchorIdx = ids.indexOf(anchorId);
          if (fromIdx < 0 || anchorIdx < 0) { navRangeRef.current = null; return; }
          const nextIdx = step(kind, ids, fromIdx);
          if (nextIdx === null) return;
          e.preventDefault();
          const lo = Math.min(anchorIdx, nextIdx);
          const hi = Math.max(anchorIdx, nextIdx);
          const appliedIds = applySelection(kind, ids.slice(lo, hi + 1));
          navRangeRef.current = { kind, scopeId, anchorId, cursorId: ids[nextIdx], ids, appliedIds };
          return;
        }

        // plain move — single item, no range
        if (!mode || !mode.ids.length || (cursorId !== null && !mode.ids.includes(cursorId))) return;
        const nextIdx = step(mode.kind, mode.ids, cursorId ? mode.ids.indexOf(cursorId) : -1);
        if (nextIdx === null) return;
        e.preventDefault();
        if (mode.kind === 'note') {
          s.select(mode.ids[nextIdx]);
        } else {
          const carrierId = mode.ids[nextIdx];
          s.selectMany(chordNoteIds(doc, carrierId), false, [carrierId]);
        }
      } else if (e.altKey && !meta && !e.shiftKey && /^Digit\d$/.test(e.code)) {
        // ⌥ + digit pins the armed element to that slot (by `code`: ⌥ + digit types a symbol on a Mac)
        const index = Array.from({ length: HOTBAR_SLOT_COUNT }, (_, i) => i).find((i) => `Digit${hotbarSlotKey(i)}` === e.code);
        if (index !== undefined && s.tool !== 'select' && (parseTool(s.tool) || parseMark(s.tool))) {
          e.preventDefault();
          s.setHotbarSlot(index, s.tool);
        }
      } else if (!meta && !e.altKey) {
        // hotbar quick-select: 1-9 then 0 (the 10th slot — matches the common browser-tab
        // convention, not a wraparound). Empty slots are inert — the key is reserved for them but
        // does nothing until something is dropped in (future work).
        for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
          if (e.key !== hotbarSlotKey(i)) continue;
          const slotTool = s.hotbarSlots[i];
          if (slotTool) {
            e.preventDefault();
            s.setTool(slotTool, i);
          }
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ownsInput]);

  // Layout = the app shell's skeleton (variant E). Wide: the left rail (same surface and width as
  // browse's) holds identity, then the hotbar and the staff · voice row, then ONE area that is the
  // hot panel (library, constructor) while nothing is selected and the inspector while
  // something is — swapped with lift + settle, so the sheet never reflows. A focus workspace: no
  // app navigation here; the back link is the way out. The sheet is centred in the content column with
  // browse's gutters; the top bar spans that column. Nothing floats over the sheet.
  // ≤1024px: the library becomes a drawer, the inspector a bottom sheet, and tools a bottom tray.
  return (
    <motion.div className={'app editor-screen' + (waterfall ? ' is-waterfall' : '') + (scorePanelOpen ? '' : ' is-rail-closed') + (reading ? ' is-reading' : '') + (pushed ? ' is-stage-pushed' : '')} style={{ '--panel-layout-w': layoutWidth } as MotionStyle}>
      <motion.div className="editor-panel-control" style={{ x: toggleX }}>
        <PanelToolbarControl
          ref={panelToggleRef}
          className="panel-toggle"
          title={railOpen ? 'Hide panel (\\)' : 'Show panel (\\)'}
          aria-label={railOpen ? 'Hide panel' : 'Show panel'}
          aria-expanded={railOpen}
          aria-controls="editor-rail"
          onClick={togglePanel}
        ><CollapsePanelIcon /></PanelToolbarControl>
      </motion.div>
      <motion.header
        ref={barRef}
        className="editor-bar"
        style={{ left: headerLeft, '--header-left': headerOffset, pointerEvents: barAwake ? undefined : 'none' } as MotionStyle}
        animate={{ opacity: barAwake ? 1 : 0 }}
        transition={reduce ? reducedFade : springSnappy}
      >
        <EditorDocumentActions key={`${savedScoreId ? 'saved' : 'draft'}:${activeId}`} draftId={draftId} savedScoreId={savedScoreId} onTitleChange={onDocumentTitle} onNotice={setDocumentNotice} />
        <PlaybackBar />
        <div className="bar-history" role="group" aria-label={waterfall ? 'View controls' : 'Editing controls'}>
          <AnimatePresence initial={false}>
            {!waterfall && !reading && <motion.div key="editing" className="bar-editing" {...settleMotion(reduce, 4)}>
            <button
              type="button"
              className={'icon-btn ghost' + (locked ? ' active' : '')}
              title={playbackLocked ? 'Editing locked during playback' : manualLocked ? 'Editing locked — unlock (L)' : 'Lock editing (L)'}
              aria-label="Lock editing" aria-pressed={locked}
              disabled={playbackLocked}
              onClick={() => setLocked(!manualLocked)}
            >
              <LockIcon locked={locked} />
            </button>
            <button type="button" className="icon-btn ghost" disabled={locked} onClick={() => void undo()} title="Undo (Cmd+Z)" aria-label="Undo">
              <UndoIcon />
            </button>
            <button type="button" className="icon-btn ghost" disabled={locked} onClick={() => void redo()} title="Redo (Cmd+Shift+Z)" aria-label="Redo">
              <RedoIcon />
            </button>
            </motion.div>}
          </AnimatePresence>
          {/* where the panel's own foot is not on screen, the light switch is in the bar */}
          {!wide && <LightSwitch />}
          {/* the view switch is the bar's last item: it stays where it is whichever view is shown */}
          <ChoiceGroup value={requestedView} onChange={requestView} options={VIEW_OPTIONS} ariaLabel="View" variant="tabs" />
        </div>
      </motion.header>
      <motion.aside
        id="editor-rail"
        ref={railRef}
        className="rail editor-rail"
        aria-label={railView.current === 'waterfall' ? 'Waterfall' : reading ? 'Playback settings' : 'Editor'}
        style={{ x: railX }}
      >
        <PanelToolbar label={railView.current === 'waterfall' ? 'Waterfall' : reading ? 'Playback' : 'Tools'} className="editor-panel-toolbar" />
        {railView.current === 'waterfall' ? <>
          <WaterfallPanel listening={reading} sky={sky} onSky={setSky} stripColor={stripColor} onStripColor={setStripColor} tilt={tilt} onTilt={setTilt} octaveLines={octaveLines} onOctaveLines={setOctaveLines} measureLines={measureLines} onMeasureLines={setMeasureLines} backgroundDust={backgroundDust} onBackgroundDust={setBackgroundDust} />
          <div className="rail-foot">
            <HelpPopover topic="waterfall" />
            {wide && <LightSwitch />}
          </div>
        </> : <>
          {wide && !reading && <div className="rail-tools">
            <Toolbar layout="rail" />
          </div>}
          <div className="rail-context">
            <AnimatePresence initial={false} mode="wait">
              {reading ? (hasSelection ? (
                <motion.div key="info" className="rail-swap" {...settleMotion(reduce)}>
                  <section className="inspector inspector--rail" aria-label="Selection">
                    <div className="inspector-body"><div className="props-content"><SelectionInfo /></div></div>
                  </section>
                </motion.div>
              ) : <motion.div key="listening" className="rail-swap rail-listening" {...settleMotion(reduce)}><div className="waterfall-panel"><ListeningControls /></div></motion.div>) : locked ? (
                <motion.div key="locked" className="rail-swap rail-locked" {...settleMotion(reduce)}>
                  <div className="locked-note" role="status">
                    <LockIcon locked />
                    <strong>{playbackLocked ? 'Editing paused for playback' : 'Editing is locked'}</strong>
                    <p>{playbackLocked ? 'Switch to Editor and stop playback to edit.' : 'Nothing on the score can be selected or changed. Playback stays live.'}</p>
                    {!playbackLocked && <button type="button" className="editor-action" onClick={() => setLocked(false)}>
                      Unlock <kbd>L</kbd>
                    </button>}
                  </div>
                </motion.div>
              ) : wide && hasSelection ? (
                <motion.div key="inspector" className="rail-swap" {...settleMotion(reduce)}>
                  <PropertiesPanel placement="rail" />
                </motion.div>
              ) : (
                <motion.div key="hot" className="rail-swap rail-hot" {...settleMotion(reduce)}>
                  <HotPanel onRequestOpen={openLibrary} onPick={wide ? undefined : closeLibrary} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="rail-foot">
            <HelpPopover />
            {wide && <LightSwitch />}
          </div>
        </>}
      </motion.aside>
      <motion.main
        ref={deskRef}
        className="desk"
        style={{ x: deskShift, opacity: 1, zIndex: stageOnTop ? 1 : 2,
          visibility: waterfall && requestedView === 'waterfall' && deskCovered ? 'hidden' : 'visible' }}
      >
        {!documentLoading && document.id === activeId && <ContextStrip readOnly={reading} />}
        <div className="desk-content">
          {documentReady && <EditorView
            key={activeId}
            scoreActive={!waterfall || requestedView === 'editor'}
            onFirstPaint={onScorePaint}
            title={documentTitle?.draftId === draftId ? documentTitle?.title : undefined}
          />}
        </div>
      </motion.main>
      <motion.div
        ref={stageRef}
        className="waterfall-stage"
        style={{ '--sky-now': `var(--waterfall-sky-${sky})`, opacity: 0, zIndex: stageOnTop ? 2 : 1 } as MotionStyle}
      >
        {/* Uniform scaling preserves the keys; the preallocated upper roll fills the space it reveals. */}
        <motion.div className="waterfall-fit" style={{ height: stageCanvasHeight, scale: stageScale, originX: 1, originY: 1 }}>
          <WaterfallStage
            sky={sky}
            active={waterfall && phase !== 'exiting'}
            preparingView={phase !== 'exiting' && preparingView && requestedView === 'waterfall'}
            onFirstFrame={setPaintedWaterfall}
            stripColor={stripColor}
            tilt={tilt}
            viewportRef={stageRef}
            octaveLines={octaveLines}
            measureLines={measureLines}
            backgroundDust={backgroundDust}
          />
        </motion.div>
      </motion.div>
      <div className="editor-view-transition">
        <TransitionLoading waiting={preparingView} label={requestedView === 'waterfall' ? 'Preparing frames…' : 'Opening score…'} />
      </div>
      {!wide && !waterfall && !reading && <PropertiesPanel placement="sheet" />}
      {!wide && !waterfall && !reading && <Toolbar layout="tray" />}
      {/* the anchor positions; the toast inside settles up onto it and lifts away when dismissed */}
      <div className="editor-toast-anchor">
        <AnimatePresence>
          {toastText ? (
            <motion.div key={toastText} className="editor-toast" role="alert" {...settleMotion(reduce)}>
              <AlertIcon /><span>{toastText}</span>
              <button type="button" className="icon-btn ghost" aria-label="Dismiss error" onClick={dismissToast}><CloseIcon /></button>
            </motion.div>
          ) : pitchNotice && <PitchModeNotice key={pitchNotice.text} notice={pitchNotice} />}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
