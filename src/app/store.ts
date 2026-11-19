import { emptyPresentation } from '@/core/model/presentation';
import { create } from 'zustand';
import type { PitchMode, ScoreDocument, StemPlacement } from '@/core/model/score';
import type { ScoreSource } from '@/core/model/scoreSource';
import type { ScoreSummary } from '@/core/gateway/LibraryGateway';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import { toBeats } from '@/core/model/contexts';
import { carrierIdOf, chordNoteIds, contentSelection, contextContentSelection, measureContentSelection, withGraces } from '@/core/model/query';
import { parseMark } from '@/core/model/markTools';
import { parseTool } from '@/core/model/insertItems';
import { parseHexColor } from '@/core/model/voiceColors';
import type { Command } from '@/core/commands/command';
import type { EditorGateway } from '@/core/gateway/EditorGateway';
import { HttpGateway } from '@/core/gateway/HttpGateway';
import { QueuedGateway } from '@/core/gateway/QueuedGateway';
import { AuthRequiredError } from '@/core/auth/authorizedFetch';
import { useAuthPrompt } from '@/core/auth/authPrompt';

export type EditorEditEvent = {
  phase: 'start' | 'success'; draftId: string; command: Command;
  before: ScoreDocument; after?: ScoreDocument;
};
let coverageGeneration = 0;
const editListeners = new Set<(event: EditorEditEvent) => void>();
export function subscribeEditorEdits(listener: (event: EditorEditEvent) => void): () => void {
  editListeners.add(listener);
  return () => { editListeners.delete(listener); };
}
function publishEdit(event: EditorEditEvent): void {
  for (const listener of editListeners) listener(event);
}

/** Turns a gateway failure into the editor's `error` string — EXCEPT an `AuthRequiredError`
 *  (anonymous, or the token expired and couldn't refresh): that opens the login modal and, on a
 *  successful sign-in, retries the very operation that hit the wall. No scary inline error then. */
function toEditorError(e: unknown, retry: () => void): string | null {
  if (e instanceof AuthRequiredError) {
    useAuthPrompt.getState().open(retry);
    return null;
  }
  return e instanceof Error ? e.message : String(e);
}

/** 'select', or an insert item's id (see core/model/insertItems: 'q', 'rest', 'triplet', '32',
 *  'rest:8', constructor composites…). */
export type Tool = string;

const DEFAULT_SLOTS: (Tool | null)[] = ['w', 'h', 'q', '8', '16', 'rest', 'triplet', null, null, null];

// The slots live in the browser only (not on the backend). Read once at start, so the
// 1–0 hotkeys see the pinned slots from the first keypress; unknown ids are dropped.
function loadList(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function saveList(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage blocked: the change lives for this session only
  }
}
const PITCH_POLICY_KEY = 'editor.pitchPolicy';
const BEAM_SHARE_KEY = 'editor.beamShare';
const VOICE_COLORS_KEY = 'editor.voiceColors';

function loadVoiceColors(): Record<string, string> {
  const saved = loadList(VOICE_COLORS_KEY);
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved).flatMap(([voiceId, value]) => {
    const color = typeof value === 'string' ? parseHexColor(value) : null;
    return color === null ? [] : [[voiceId, color]];
  }));
}
/** how much of a measure a beam holds, as a fraction of it: nothing, a quarter, a half, all of it */
export const BEAM_SHARES = [
  { key: 'off', numerator: 0, denominator: 1 },
  { key: 'quarter', numerator: 1, denominator: 4 },
  { key: 'half', numerator: 1, denominator: 2 },
  { key: 'whole', numerator: 1, denominator: 1 },
] as const;
export type BeamShare = (typeof BEAM_SHARES)[number]['key'];
function loadSlots(): (Tool | null)[] {
  const raw = loadList('editor.hotbarSlots');
  if (!Array.isArray(raw) || raw.length !== HOTBAR_SLOT_COUNT) return DEFAULT_SLOTS;
  return raw.map((t) => (typeof t === 'string' && (parseTool(t) || parseMark(t)) ? t : null));
}

/** number of quick-access hotbar slots (DESIGN.md §4/§7's "Deck") — hotkeys 1-9 then 0, matching
 *  the common browser-tab convention (0 = the 10th slot, not "before 1"). `null` = an empty,
 *  reachable-but-unfilled slot — visually present with its hotkey label, functionally inert until
 *  something is dropped into it. The cursor/select tool is NOT one of these ten: it has its own
 *  fixed hotkey (V, see EditorScreen.tsx) since it's not a "stamp" you fill/rearrange like the rest. */
export const HOTBAR_SLOT_COUNT = 10;
/** the digit each slot index binds to — index 9 is '0' (the 10th key on the row), not a wraparound. */
export function hotbarSlotKey(index: number): string {
  return index === 9 ? '0' : String(index + 1);
}

const EMPTY_DOC: ScoreDocument = {
  id: '',
  title: '',
  staffOrder: [],
  voices: [],
  measures: [],
  musicRevision: '', presentation: emptyPresentation(), presentationCapabilities: [],
  stemOverrides: {},
  ties: [],
  glissandos: [],
  beams: [],
  tuplets: [],
  contexts: [],
};

interface EditorState {
  // the backend owns the draft document + undo/redo journal, keyed by score id;
  // the client holds the last rendered view + transient UI state only.
  scoreId: string;
  source: ScoreSource | null;
  savedScore: ScoreSummary | null;
  document: ScoreDocument;
  loading: boolean;
  error: string | null;

  tool: Tool;
  /** the hotbar slot the tool was picked from, or null (picked from the library, the constructor
   *  or V). Slots are identified by index, so the same item pinned twice stays two slots: only the
   *  one actually used reads active. */
  activeSlot: number | null;
  /** the ten quick-access hotbar slots, in hotkey order (index 0 = key "1", … index 9 = key "0") —
   *  `null` is an empty slot. Currently a fixed starting layout (the 5 duration tools, then the
   *  quarter-rest and eighth-triplet stamps); the
   *  eventual drag-from-constructor customization (DESIGN.md §13) will call `setHotbarSlot` to
   *  rearrange it — the slot MODEL is built now so that feature only appends, per this repo's
   *  usual "don't rewrite it twice" rule. */
  hotbarSlots: (Tool | null)[];
  /** Placeholder for command construction; dispatch asks for each edit's actual mode. */
  pitchMode: PitchMode;
  /** How an edit that changes how notes read (a clef, an octave line, a note moved to another staff) is treated: asked each time, or always the same. Kept in the browser. */
  pitchPolicy: 'ask' | PitchMode;
  setPitchPolicy: (policy: 'ask' | PitchMode) => void;
  /** how much of a measure a beam entered by hand holds before the next note begins another; off beams nothing. Kept in the browser. */
  beamShare: BeamShare;
  setBeamShare: (share: BeamShare) => void;
  /** an edit waiting for the user's choice of mode: the prompt under the strip's policy chip answers it */
  pitchModeRequest: { resolve: (mode: PitchMode | null) => void; command: Command } | null;
  resolvePitchMode: (mode: PitchMode | null) => void;
  /** the last edit made under a fixed policy, until the next edit: the notice offers the other mode or an undo */
  pitchNotice: { command: Command; mode: PitchMode; text: string } | null;
  clearPitchNotice: () => void;
  /** the strip's policy menu is open (the inspectors' "Change" link opens it too) */
  policyMenuOpen: boolean;
  setPolicyMenuOpen: (open: boolean) => void;
  auditionSuppressed: boolean;
  setContextFactor: (id: string, factor: number) => void;
  selectedIds: string[];
  scrollToSelection: boolean;
  // carrier ids that were selected AT CARRIER GRANULARITY (via the stem handle or a chord
  // double-click), not derived from `selectedIds`/note counts — needed specifically to
  // distinguish a single-note carrier's "select the carrier" action (stem-click / double-click,
  // which must show stem context) from a plain notehead click on that same lone note (a NOTE
  // selection, which must not — see PropertiesPanel's `isStemCarrier`). For a real (2+ note)
  // chord this is redundant with "every note selected" and isn't needed to tell the two apart,
  // but is still set for consistency. Reset to `[]` by any note-granularity selection action
  // (plain `select`, marquee/group `selectMany` with no `carrierIds`).
  carrierSelectedIds: string[];
  // measures picked by a barline click, together with their notes in `selectedIds` — measures are
  // their own selection (insert / remove / time signature act on them), so every other selection
  // action clears this.
  selectedMeasureIds: string[];
  // beams and tuplet brackets picked by a click on them — structure, not notes, so they have their
  // own selection (a beam is removed, never edited per note); every note/measure pick clears it.
  selectedStructureIds: string[];
  zoom: number;
  locked: boolean;
  manualLocked: boolean;
  playbackLocked: boolean;

  // current working target (which staff / voice edits act on). The staff pick is a deliberate
  // manual choice, not inferred from click geometry — it's what lets you choose ledger lines on
  // the current staff vs. a cross-staff note on the other one (see Overlay.tsx's
  // resolveInsertTarget).
  currentStaff: string;
  currentVoice: number;

  // custom voice-color overrides (keyed by voice id) — unset voices fall back to the default
  // palette cycling by index (see core/model/voiceColors). Drives the voice popover's swatch, the
  // score's selection highlight, and the insert-ghost preview, so they never drift apart.
  voiceColors: Record<string, string>;

  // stem overrides as drawn (keyed by note carrier id): the document's saved ones, with a live
  // drag preview laid on top until the next document arrives. Unset carriers get VexFlow's
  // automatic direction (see VexflowRenderer.tsx's `auto_stem`).
  stemOverrides: Record<string, StemPlacement>;

  gateway: EditorGateway;

  load: (scoreId: string) => Promise<void>;
  loadSource: (source: ScoreSource) => Promise<void>;
  clearSource: () => void;
  /** `forcedMode`: an edit that reads notes differently runs in this mode, whatever the policy says */
  dispatch: (command: Command, forcedMode?: PitchMode) => Promise<void>;
  deleteSelected: () => Promise<void>;
  shiftSelectedNotes: (delta: -1 | 1) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** `slot`: the hotbar slot it was picked from (click or hotkey); omitted for everything else */
  setTool: (tool: Tool, slot?: number) => void;
  /** fills/clears one hotbar slot (a drop from the library or the constructor's Save) */
  setHotbarSlot: (index: number, tool: Tool | null) => void;
  /** null clears; additive (Shift) toggles the id in/out of the set. */
  select: (id: string | null, additive?: boolean) => void;
  selectStructure: (id: string, additive: boolean) => void;
  /** Replace or union a group pick; carriers control whole-glyph tint, structures its relations. */
  selectMany: (ids: string[], additive: boolean, carrierIds?: string[], structureIds?: string[], options?: { scroll?: boolean }) => void;
  /** the double-click rule for a context: select what it is applied to — the backend owns that rule */
  selectContextContent: (contextId: string, additive: boolean) => Promise<void>;
  /** select a measure — alone when `noteIds` is empty, with its content (`noteIds`) otherwise;
   *  additive (Shift) unions with the current measure selection. */
  selectMeasure: (measureId: string, noteIds: string[], additive: boolean) => void;
  setZoom: (zoom: number) => void;
  setLocked: (locked: boolean) => void;
  setPlaybackLocked: (locked: boolean) => void;
  setCurrentStaff: (id: string) => void;
  setCurrentVoice: (voice: number) => void;
  /** null resets the voice back to its default palette color. */
  setVoiceColor: (voiceId: string, color: string | null) => void;
  /** null clears the override, reverting the note to automatic stem direction/length. */
  /** shows a stem the way it is being dragged, without saving it (one call per frame). */
  previewStem: (carrierId: string, override: StemPlacement) => void;
  /** saves stems for several carriers at once (`null` = automatic) — one gesture, one undo entry. */
  commitStems: (carrierIds: string[], override: StemPlacement | null) => Promise<void>;
}

// Queued so edit requests to one draft (load/apply/undo/redo) are always in flight
// one at a time, in call order — see QueuedGateway for why.
const gateway: EditorGateway = new QueuedGateway(new HttpGateway());

export const useEditor = create<EditorState>((set, get) => ({
  scoreId: 'default',
  source: null,
  savedScore: null,
  document: EMPTY_DOC,
  loading: true,
  error: null,
  tool: 'select',
  activeSlot: null,
  // starting layout: the 5 duration tools in their old toolbar order, the rest and triplet stamps,
  // then 3 empty slots ready to be filled later. Not derived from anything — this is the
  // deliberate default arrangement.
  hotbarSlots: loadSlots(),
  pitchMode: 'preserve_pitch',
  pitchPolicy: (() => { const raw = loadList(PITCH_POLICY_KEY); return raw === 'preserve_pitch' || raw === 'preserve_step' ? raw : 'ask'; })(),
  setPitchPolicy: (policy) => { saveList(PITCH_POLICY_KEY, policy); set({ pitchPolicy: policy }); },
  beamShare: (() => { const raw = loadList(BEAM_SHARE_KEY); return BEAM_SHARES.find((share) => share.key === raw)?.key ?? 'half'; })(),
  setBeamShare: (share) => { saveList(BEAM_SHARE_KEY, share); set({ beamShare: share }); },
  pitchModeRequest: null,
  resolvePitchMode: (mode) => {
    const request = get().pitchModeRequest;
    set({ pitchModeRequest: null });
    request?.resolve(mode);
  },
  pitchNotice: null,
  clearPitchNotice: () => set({ pitchNotice: null }),
  policyMenuOpen: false,
  setPolicyMenuOpen: (open) => set({ policyMenuOpen: open }),
  auditionSuppressed: false,
  setContextFactor: (id, factor) => { void get().dispatch({ type: 'editPresentation', changes: [
    { kind: 'vertical', target: { entity_id: id, reference: 'body' }, offset: factor === 1 ? null : factor },
  ] }); },
  selectedIds: [],
  scrollToSelection: true,
  selectedStructureIds: [],
  carrierSelectedIds: [],
  selectedMeasureIds: [],
  zoom: 1,
  locked: false,
  manualLocked: false,
  playbackLocked: false,
  currentStaff: '',
  currentVoice: 0,
  voiceColors: loadVoiceColors(),
  stemOverrides: {},
  gateway,

  load: (scoreId) => get().loadSource({ kind: 'draft', id: scoreId }),
  loadSource: async (source) => {
    get().resolvePitchMode(null);
    set({ source, scoreId: source.id,
      savedScore: null, document: EMPTY_DOC, stemOverrides: {}, loading: true, error: null,
      tool: 'select', activeSlot: null, pitchNotice: null, policyMenuOpen: false,
      selectedIds: [], carrierSelectedIds: [], selectedMeasureIds: [], selectedStructureIds: [],
      manualLocked: false, locked: get().playbackLocked });
    try {
      const saved = source.kind === 'saved' ? await libraryGateway.getScoreDocument(source.id) : null;
      if (source.kind === 'saved' && !saved) throw new Error('This score could not be found.');
      const document = saved ? saved.document : await get().gateway.load(source.id);
      if (get().source !== source) return;
      set({ document, savedScore: saved?.score ?? null, stemOverrides: document.stemOverrides,
        loading: false, error: null, currentStaff: document.staffOrder[0] || '', currentVoice: 0 });
    } catch (e) {
      if (get().source !== source) return;
      set({ loading: false, error: toEditorError(e, () => {
        if (get().source === source) void get().loadSource(source);
      }) });
    }
  },
  clearSource: () => {
    get().resolvePitchMode(null);
    set({ source: null, savedScore: null, document: EMPTY_DOC, loading: true,
      error: null, tool: 'select', activeSlot: null, selectedIds: [], carrierSelectedIds: [],
      selectedMeasureIds: [], selectedStructureIds: [], stemOverrides: {}, pitchNotice: null });
  },

  // The lock is enforced HERE, at the one door every edit goes through (dispatch, undo, redo,
  // arming an insert tool, the stem drag preview) — not by each control: a new control can't
  // forget it.
  dispatch: async (command, forcedMode) => {
    if (get().loading || get().source?.kind === 'saved' || get().locked || get().pitchModeRequest) return;
    set({ pitchNotice: null });
    const scoreId = get().scoreId;
    const source = get().source;
    const before = get().document;
    const movingContext = command.type === 'moveContextStart' || command.type === 'moveContextEnd';
    const contextId = command.type === 'moveContextStart' || command.type === 'moveContextEnd' ? command.contextId : null;
    const context = before.contexts.find((c) => c.id === contextId);
    let noticeMode: PitchMode | null = null;
    if ('mode' in command && (!movingContext || context?.kind === 'clef' || context?.kind === 'octave')) {
      const policy = get().pitchPolicy;
      const asked = !forcedMode && policy === 'ask';
      const given = forcedMode ?? policy;
      const mode = given === 'ask' ? await new Promise<PitchMode | null>((resolve) => set({ pitchModeRequest: { resolve, command } })) : given;
      if (mode === null || get().source?.kind === 'saved' || get().locked || get().source !== source || get().scoreId !== scoreId || get().document !== before) return;
      command = { ...command, mode };
      noticeMode = asked || forcedMode ? null : mode;
    }
    if (command.type === 'insertNote' && command.beamShare === undefined) {
      const share = BEAM_SHARES.find((entry) => entry.key === get().beamShare)!;
      command = { ...command, beamShare: { numerator: share.numerator, denominator: share.denominator } };
    }
    const event = { draftId: scoreId, command, before };
    publishEdit({ ...event, phase: 'start' });
    try {
      const document = await get().gateway.apply(scoreId, command);
      if (get().source !== source) return;
      const existing = new Set([...document.beams, ...document.tuplets, ...document.ties, ...document.glissandos, ...document.contexts].map(element => element.id));
      set({ document, stemOverrides: document.stemOverrides, error: null,
        selectedStructureIds: get().selectedStructureIds.filter(id => existing.has(id)) });
      publishEdit({ ...event, phase: 'success', after: document });
      if (noticeMode) {
        // a fixed policy answered without asking: say what it did, with a way to take the other mode
        const was = new Map(before.measures.flatMap(m => m.voices.flatMap(v => withGraces(v.items).flatMap(i => i.notes.map(n => [n.noteId, n] as const)))));
        const changed = document.measures.flatMap(m => m.voices.flatMap(v => withGraces(v.items).flatMap(i => i.notes)))
          .filter(n => { const old = was.get(n.noteId); return old && (noticeMode === 'preserve_pitch' ? old.staffStep !== n.staffStep : old.midiNote !== n.midiNote); }).length;
        const edit = ({ setClef: 'Clef changed', deleteClef: 'Clef removed', createOctaveTransposition: 'Octave line added', deleteOctaveTransposition: 'Octave line removed',
          openContextEnd: 'Line extended', moveContextStart: 'Start moved', moveContextEnd: 'End moved', moveNoteToStaff: 'Note moved' } as Record<string, string>)[command.type] ?? 'Edit applied';
        const outcome = noticeMode === 'preserve_pitch' ? `Kept sound: ${changed} ${changed === 1 ? 'note' : 'notes'} redrawn.` : `Kept position: ${changed} ${changed === 1 ? 'note' : 'notes'} changed pitch.`;
        set({ pitchNotice: { command, mode: noticeMode, text: `${edit}. ${outcome}` } });
      }
    } catch (e) {
      if (get().source === source) set({ error: toEditorError(e, () => {
        if (get().source === source) void get().dispatch(command);
      }) });
    }
  },

  shiftSelectedNotes: async (delta) => {
    const state = get();
    if (state.loading || state.source?.kind === 'saved' || state.locked || state.pitchModeRequest) return;
    const selected = new Set(state.selectedIds);
    const noteIds = state.document.measures.flatMap(measure => measure.voices.flatMap(voice =>
      withGraces(voice.items).flatMap(item => item.notes.filter(note => selected.has(note.noteId)).map(note => note.noteId))));
    if (noteIds.length) await state.dispatch({ type: 'shiftStaffSteps', noteIds, delta });
  },

  deleteSelected: async () => {
    if (get().loading || get().source?.kind === 'saved' || get().locked) return;
    // `selectedIds` holds INDIVIDUAL note ids (one note within a chord is selectable on its own —
    // see Overlay.tsx). Group them by owning carrier: a carrier with EVERY note selected (the
    // common "single-note carrier" and "whole chord via fast double-click" cases) is deleted whole;
    // a carrier with only SOME notes selected has just those notes removed, leaving the rest of the
    // chord intact. BOTH kinds go in ONE `deleteBatch` gesture → a single Delete is a single undo
    // entry regardless of how the selection mixes whole carriers and partial chord-notes.
    const doc = get().document;
    const ids = get().selectedIds;
    const structureIds = get().selectedStructureIds;
    if (!ids.length && !structureIds.length) return;
    set({ selectedIds: [], carrierSelectedIds: [], selectedMeasureIds: [], selectedStructureIds: [] });

    const selectedByCarrier = new Map<string, string[]>();
    for (const id of ids) {
      const carrierId = carrierIdOf(doc, id);
      const arr = selectedByCarrier.get(carrierId) ?? [];
      arr.push(id);
      selectedByCarrier.set(carrierId, arr);
    }

    // Build a FLAT list of entity ids: a fully-selected carrier collapses to its carrier id (drop
    // the whole chord), a partially-selected one contributes its picked note ids (drop those notes,
    // keep the rest). The backend resolves + classifies each id, so both kinds go in one array.
    // beams, tuplets and the contexts the generic delete takes; a clef and an octave line go by
    // their own commands (they ask how their notes are treated), and what the score opens with
    // (its first clef, key, tempo and dynamics) cannot be deleted at all
    const mode = get().pitchMode;
    const first = doc.measures[0]?.id;
    const entityIds: string[] = [];
    const ownCommands: Command[] = [];
    for (const id of structureIds) {
      const context = doc.contexts.find((c) => c.id === id);
      if (!context) entityIds.push(id);
      else if (context.measureId === first && toBeats(context.position) === 0 && ['clef', 'keySignature', 'tempo', 'dynamic'].includes(context.kind)) continue;
      else if (context.kind === 'clef') ownCommands.push({ type: 'deleteClef', clefId: id, measureIds: [context.measureId], mode });
      else if (context.kind === 'octave') ownCommands.push({ type: 'deleteOctaveTransposition', octaveId: id, mode });
      else entityIds.push(id);
    }
    for (const [carrierId, selectedInCarrier] of selectedByCarrier) {
      const allNoteIds = chordNoteIds(doc, carrierId);
      const isWholeCarrier = allNoteIds.every((nid) => selectedInCarrier.includes(nid));
      if (isWholeCarrier) entityIds.push(carrierId);
      else entityIds.push(...selectedInCarrier);
    }

    if (entityIds.length) {
      await get().dispatch({ type: 'deleteBatch', entityIds });
    }
    for (const command of ownCommands) await get().dispatch(command);
  },

  undo: async () => {
    if (get().loading || get().source?.kind === 'saved' || get().locked) return;
    const source = get().source;
    set({ pitchNotice: null });
    try {
      const document = await get().gateway.undo(get().scoreId);
      if (get().source !== source) return;
      set({ document, stemOverrides: document.stemOverrides, error: null });
    } catch (e) {
      if (get().source === source) set({ error: toEditorError(e, () => {
        if (get().source === source) void get().undo();
      }) });
    }
  },

  redo: async () => {
    if (get().loading || get().source?.kind === 'saved' || get().locked) return;
    const source = get().source;
    set({ pitchNotice: null });
    try {
      const document = await get().gateway.redo(get().scoreId);
      if (get().source !== source) return;
      set({ document, stemOverrides: document.stemOverrides, error: null });
    } catch (e) {
      if (get().source === source) set({ error: toEditorError(e, () => {
        if (get().source === source) void get().redo();
      }) });
    }
  },

  // entering an insert tool (any non-select tool) drops the current selection — inserting
  // while old elements are still selected read as if they were about to be affected too.
  setTool: (tool, slot) =>
    set((s) =>
      s.locked || s.loading || s.source?.kind === 'saved' && tool !== 'select'
        ? {}
        : {
            tool,
            activeSlot: slot ?? null,
            selectedIds: tool === 'select' ? s.selectedIds : [],
            carrierSelectedIds: tool === 'select' ? s.carrierSelectedIds : [],
            selectedMeasureIds: tool === 'select' ? s.selectedMeasureIds : [],
            selectedStructureIds: tool === 'select' ? s.selectedStructureIds : [],
          },
    ),

  setHotbarSlot: (index, tool) =>
    set((s) => {
      if (index < 0 || index >= HOTBAR_SLOT_COUNT) return {};
      if (tool && !parseTool(tool) && !parseMark(tool)) return {};
      const hotbarSlots = [...s.hotbarSlots];
      hotbarSlots[index] = tool;
      saveList('editor.hotbarSlots', hotbarSlots);
      // re-pinning the slot that is in use drops it out of use (its item changed under it)
      return s.activeSlot === index ? { hotbarSlots, activeSlot: null } : { hotbarSlots };
    }),

  select: (id, additive = false) =>
    set((s) => {
      if (s.locked) return {};
      if (id === null) return { selectedIds: [], scrollToSelection: true, carrierSelectedIds: [], selectedMeasureIds: [], selectedStructureIds: [] };
      if (additive) {
        return s.selectedIds.includes(id)
          ? { selectedIds: s.selectedIds.filter((x) => x !== id), scrollToSelection: true, selectedMeasureIds: [] }
          : { selectedIds: [...s.selectedIds, id], scrollToSelection: true, selectedMeasureIds: [] };
      }
      // a fresh plain click is a NOTE-granularity pick, even if it happens to land on a
      // single-note carrier — drop any prior carrier-level selection.
      return { selectedIds: [id], scrollToSelection: true, carrierSelectedIds: [], selectedMeasureIds: [], selectedStructureIds: [] };
    }),

  selectStructure: (id, additive) =>
    set((s) => {
      if (s.locked) return {};
      if (!additive) return { selectedIds: [], carrierSelectedIds: [], selectedMeasureIds: [], selectedStructureIds: [id] };
      return {
        selectedStructureIds: s.selectedStructureIds.includes(id)
          ? s.selectedStructureIds.filter((x) => x !== id)
          : [...s.selectedStructureIds, id],
      };
    }),

  selectMany: (ids, additive, carrierIds = [], structureIds = [], { scroll = true } = {}) =>
    set((s) => {
      if (s.locked) return {};
      if (additive) {
        return {
          selectedIds: [...new Set([...s.selectedIds, ...ids])],
          scrollToSelection: scroll,
          carrierSelectedIds: [...new Set([...s.carrierSelectedIds, ...carrierIds])],
          selectedStructureIds: carrierIds.length
            ? contentSelection(s.document, [...s.selectedIds, ...ids], [...s.selectedStructureIds, ...structureIds]).structureIds
            : [...new Set([...s.selectedStructureIds, ...structureIds])],
          selectedMeasureIds: [],
        };
      }
      return { selectedIds: [...new Set(ids)], scrollToSelection: scroll, carrierSelectedIds: [...new Set(carrierIds)], selectedMeasureIds: [], selectedStructureIds: [...new Set(structureIds)] };
    }),

  selectMeasure: (measureId, noteIds, additive) =>
    set((s) => {
      if (s.locked) return {};
      // alone, a measure picks only itself; with its content (`noteIds`) it also picks what starts in it
      const group = contentSelection(s.document, noteIds, noteIds.length ? measureContentSelection(s.document, measureId).structureIds : []);
      if (additive && s.selectedMeasureIds.length) {
        return {
          selectedIds: [...new Set([...s.selectedIds, ...noteIds])],
          scrollToSelection: true,
          carrierSelectedIds: [...new Set([...s.carrierSelectedIds, ...group.carrierIds])],
          selectedStructureIds: contentSelection(s.document, [...s.selectedIds, ...noteIds], [...s.selectedStructureIds, ...group.structureIds]).structureIds,
          selectedMeasureIds: [...new Set([...s.selectedMeasureIds, measureId])],
        };
      }
      return { selectedIds: group.noteIds, scrollToSelection: true, carrierSelectedIds: group.carrierIds, selectedMeasureIds: [measureId], selectedStructureIds: group.structureIds };
    }),

  selectContextContent: async (contextId, additive) => {
    const state = get();
    if (state.locked || state.loading) return;
    const { source, document, scoreId, selectedIds, carrierSelectedIds, selectedStructureIds, selectedMeasureIds } = state;
    const generation = ++coverageGeneration;
    const current = () => {
      const now = get();
      return generation === coverageGeneration && now.source === source && now.document === document && !now.locked
        && now.selectedIds === selectedIds && now.carrierSelectedIds === carrierSelectedIds
        && now.selectedStructureIds === selectedStructureIds && now.selectedMeasureIds === selectedMeasureIds;
    };
    try {
      const coverage = source?.kind === 'saved'
        ? await libraryGateway.getScoreContextCoverage(source.id, contextId)
        : await state.gateway.contextCoverage(scoreId, contextId);
      if (!current()) return;
      const group = contextContentSelection(document, contextId, coverage);
      get().selectMany(group.noteIds, additive, group.carrierIds, group.structureIds);
    } catch (e) {
      if (current()) set({ error: toEditorError(e, () => { if (current()) void get().selectContextContent(contextId, additive); }) });
    }
  },

  setZoom: (zoom) => set({ zoom: Math.max(0.5, Math.min(2, Math.round(zoom * 10) / 10)) }),

  // locking also drops an armed insert tool back to Select: while locked nothing can be inserted
  setLocked: (locked) =>
    set((s) => s.playbackLocked ? {} : ({
      manualLocked: locked,
      locked: locked || s.playbackLocked,
      tool: locked ? 'select' : s.tool,
      activeSlot: locked ? null : s.activeSlot,
      selectedIds: locked ? [] : s.selectedIds,
      carrierSelectedIds: locked ? [] : s.carrierSelectedIds,
      selectedMeasureIds: locked ? [] : s.selectedMeasureIds,
      selectedStructureIds: locked ? [] : s.selectedStructureIds,
    })),

  setPlaybackLocked: (locked) =>
    set((s) => s.playbackLocked === locked ? s : { playbackLocked: locked, locked: locked || s.manualLocked }),

  setCurrentStaff: (id) => set({ currentStaff: id }),
  setCurrentVoice: (voice) => set({ currentVoice: voice }),

  setVoiceColor: (voiceId, color) =>
    set((s) => {
      const voiceColors = { ...s.voiceColors };
      if (color === null) delete voiceColors[voiceId];
      else voiceColors[voiceId] = color;
      saveList(VOICE_COLORS_KEY, voiceColors);
      return { voiceColors };
    }),

  previewStem: (carrierId, override) =>
    set((s) => {
      const shown = s.stemOverrides[carrierId];
      // the same preview again is no change: no new object, no new drawing
      const same = shown?.direction === override.direction && shown.lengthFactor === override.lengthFactor;
      return s.locked || s.source?.kind === 'saved' || same ? {} : { stemOverrides: { ...s.stemOverrides, [carrierId]: override } };
    }),

  commitStems: async (carrierIds, override) => {
    if (carrierIds.length) {
      await get().dispatch({ type: 'setStems', carrierIds, override });
    }
    // drop any drag preview: on success this is the saved state, on failure the state before
    set({ stemOverrides: get().document.stemOverrides });
  },
}));
