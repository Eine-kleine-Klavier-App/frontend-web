import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { motion, useTransform } from 'motion/react';
import { useEditor } from '@/app/store';
import { ChoiceGroup } from '@/ui/ChoiceGroup';
import { FadeSwap } from '@/ui/FadeSwap';
import { SPRING_PANEL_BOUNCE, useLayoutSafeSpring } from '@/styles/motion';
import type { Accidental, ArticulationMark, DurationValue, OrnamentMark } from '@/core/model/score';
import { ORNAMENT_SIGNS } from '@/core/model/ornament';
import { ARTICULATION_GROUPS, ARTICULATION_LABEL, withMark } from '@/core/model/articulation';
import { describeSelection, measureContentSelection, orderedVoiceCarrierIds, splitBeamTarget, type SelectedCarrier } from '@/core/model/query';
import { staffStepToKey } from '@/core/model/pitch';
import { NotationIcon, SmuflIcon, ToolIcon } from './icons';
import { ARTICULATION_GLYPH } from './libraryItems';
import { toolLabel, NOTE_VALUES } from '@/core/model/insertItems';
import { IntegerField, RhythmField, maximumDots } from './EditorFields';
import { ContextIndex } from '@/core/model/contexts';
import { ContextInspector, ObjectHeader } from './ContextInspector';

// The inspector is a CONTEXTUAL-ACTIONS plate: it inspects the current selection and shows the
// info + actions relevant to whatever is selected (a single note, a whole chord, a rest, or a mixed
// multi-selection, or measures picked by their barline). Every action is a backend gesture; an
// action whose gesture doesn't exist yet (accidental) is intentionally NOT shown as a dead button.
//
// Two placements of the same panel, never both. `rail` (wide screens): it takes over the editor
// rail's lower area while something is selected — EditorScreen swaps it with the rail's library
// navigation (lift + settle), so the sheet never reflows. `sheet` (≤1024px): a bottom sheet above
// the tool tray, shown and hidden by the shared panel spring (`useLayoutSafeSpring` + the panel
// bounce, the same mechanic as browse's preview panel) on transform/opacity only. In both, a
// content swap is an overlapping crossfade (`FadeSwap`), never a blank middle frame.

export function staffName(staffOrder: string[], id: string): string {
  const i = staffOrder.indexOf(id);
  return i === 0 ? 'Upper' : i === 1 ? 'Lower' : `Staff ${i + 1}`;
}

const ACCIDENTAL_LABEL: Record<NonNullable<Accidental>, string> = {
  '#': '♯',
  b: '♭',
  n: '♮',
  '##': '𝄪',
  bb: '𝄫',
};

/** Spelled pitch as a musician reads it: "B4", "F♯5". The accidental shows only when one is
 *  written; a natural is the default spelling and stays implicit. */
export function spelledPitch(staffStep: number, clef: 'treble' | 'bass', accidental: Accidental): string {
  const [letter, octave] = staffStepToKey(staffStep, clef).split('/');
  const written = accidental && accidental !== 'n' ? ACCIDENTAL_LABEL[accidental] : '';
  return `${letter.toUpperCase()}${written}${octave}`;
}

const DURATION_NAME: Record<DurationValue, string> = {
  w: 'Whole',
  h: 'Half',
  q: 'Quarter',
  '8': 'Eighth',
  '16': 'Sixteenth',
  '32': 'Thirty-second',
};

export function durationName(duration: DurationValue, dots: number): string {
  return (dots > 0 ? 'Dotted ' + DURATION_NAME[duration].toLowerCase() : DURATION_NAME[duration]);
}

const DURATION_VALUE: Record<DurationValue, number> = { w: 1, h: 2, q: 4, '8': 8, '16': 16, '32': 32 };
/** the most dots a value can carry: each dot adds a note one step smaller, none may reach below the
 *  32nd, and a single size takes at most two (the backend's size mapper — a third dot comes back as
 *  one) */
const maxDots = (value: DurationValue): number => maximumDots(DURATION_VALUE[value]);

const FINGERINGS = [0, 1, 2, 3, 4, 5];
const STEM_DIRECTIONS: { value: 'auto' | 'up' | 'down'; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Automatic direction' },
  { value: 'up', label: 'Up', title: 'Stem up' },
  { value: 'down', label: 'Down', title: 'Stem down' },
];
// same injected velocities as browse's preview panel — one panel feel across the app
const OPEN_OVERSHOOT_VELOCITY = 5;
const CLOSE_ANTICIPATE_VELOCITY = 6;

const TIME_SIGNATURES = [
  { beats: 2, beatValue: 4 },
  { beats: 3, beatValue: 4 },
  { beats: 4, beatValue: 4 },
  { beats: 6, beatValue: 8 },
];

/** The stem is a CARRIER-level property (one stem shared by all of a chord's notes), so stem
 *  controls belong to the CARRIER context only. A real chord (2+ notes) selected AS A WHOLE
 *  always qualifies. A single-note carrier only qualifies when it was picked at CARRIER
 *  granularity — via the stem handle itself or a chord double-click, tracked in
 *  `carrierSelectedIds` (app/store.ts) — NOT from a plain notehead click on that same lone note,
 *  which is a NOTE selection (context: accidental / fingering, todo — need backend), not a
 *  carrier one. */
function isStemCarrier(c: SelectedCarrier, carrierSelectedIds: string[]): boolean {
  return (
    c.item.kind === 'note' &&
    c.whole &&
    c.item.duration !== 'w' &&
    (c.item.notes.length > 1 || carrierSelectedIds.includes(c.item.id))
  );
}

export function PropertiesPanel({ placement }: { placement: 'rail' | 'sheet' }) {
  const panelRef = useRef<HTMLElement>(null);
  const lastShown = useRef<{ key: string; body: ReactNode }>({ key: 'empty', body: null });
  const document = useEditor((s) => s.document);
  const selectedIds = useEditor((s) => s.selectedIds);
  const carrierSelectedIds = useEditor((s) => s.carrierSelectedIds);
  const deleteSelected = useEditor((s) => s.deleteSelected);
  const stemOverrides = useEditor((s) => s.stemOverrides);
  const commitStems = useEditor((s) => s.commitStems);
  const selectedMeasureIds = useEditor((s) => s.selectedMeasureIds);
  const selectedStructureIds = useEditor((s) => s.selectedStructureIds);
  const dispatch = useEditor((s) => s.dispatch);
  const select = useEditor((s) => s.select);
  const selectMany = useEditor((s) => s.selectMany);
  const currentStaff = useEditor((s) => s.currentStaff);

  // DESIGN.md §3.5 Apple-style motion: opacity+transform only, `--ease-standard`
  // (`cubic-bezier(0.2,0,0,1)`) — the panel's content never hard-swaps (empty <-> note <-> chord
  // <-> ...). One shared AnimatePresence (below, in the final return)
  // keyed on the coarse "what kind of thing is this" signature crossfades between them instead of
  // popping — both branches must render under the SAME AnimatePresence instance for that to work
  // across the empty <-> non-empty boundary, so the body is built as (key, content) here and
  // rendered once at the bottom, rather than two separate early-return `<aside>` trees.
  let panelKey: string;
  let body: ReactNode;
  // filtered against the document, so a pick an undo has since removed falls back to the note view
  const measures = document.measures.filter((m) => selectedMeasureIds.includes(m.id));
  const beams = document.beams.filter((b) => selectedStructureIds.includes(b.id));
  const tuplets = document.tuplets.filter((t) => selectedStructureIds.includes(t.id));
  const ties = document.ties.filter((t) => selectedStructureIds.includes(t.id));
  const glissandos = document.glissandos.filter((g) => selectedStructureIds.includes(g.id));
  const structureCount = beams.length + tuplets.length + ties.length + glissandos.length;
  const pickedContexts = document.contexts.filter((c) => selectedStructureIds.includes(c.id));

  if (structureCount > 0 && selectedIds.length === 0 && measures.length === 0) {
    // beams and tuplet brackets picked by a click on them: nothing to edit on a beam itself, so the
    // plate names the pick and offers its removal (the notes under it stay)
    panelKey = 'structure';
    const what = glissandos.length ? (structureCount === glissandos.length ? (glissandos.length === 1 ? 'Glissando' : `${glissandos.length} glissandos`) : `${structureCount} connections`) : ties.length ? (structureCount === ties.length ? (ties.length === 1 ? 'Tie' : `${ties.length} ties`) : `${structureCount} connections`) :
      beams.length && tuplets.length
        ? `${structureCount} beams and tuplets`
        : beams.length
          ? beams.length === 1
            ? 'Beam'
            : `${beams.length} beams`
          : tuplets.length === 1
            ? `Tuplet ${tuplets[0].numNotes}:${tuplets[0].notesOccupied}`
            : `${tuplets.length} tuplets`;
    body = (
      <>
        <ObjectHeader
          title={what}
          sub={beams.length && !tuplets.length ? 'Its notes stay' : tuplets.length && !beams.length ? 'Its notes go with it' : undefined}
        />
        <div className="props-section props-destructive">
          <button type="button" className="editor-action danger props-delete" onClick={() => void deleteSelected()}>
            {structureCount === 1 ? `Remove ${what.toLowerCase()}` : `Remove ${what}`}
          </button>
        </div>
      </>
    );
  } else if (pickedContexts.length > 0 && selectedIds.length === 0 && measures.length === 0) {
    // clefs, key signatures, dynamics, tempos, hairpins, slurs, octave lines: each with its own controls
    panelKey = pickedContexts.length === 1 ? `context:${pickedContexts[0].kind}` : 'contexts';
    body =
      pickedContexts.length === 1 ? (
        <ContextInspector context={pickedContexts[0]} />
      ) : (
        <>
          <ObjectHeader title={`${pickedContexts.length} marks`} />
          <div className="props-section props-destructive">
            <button type="button" className="editor-action danger props-delete" onClick={() => void deleteSelected()}>
              Remove marks
            </button>
          </div>
        </>
      );
  } else if (measures.length > 0) {
    // measures picked by their barline, in document order: insert, remove, time signature act on
    // the measures themselves — their notes stay selected only so the score shows the pick.
    panelKey = 'measure';
    const measureIds = measures.map((m) => m.id);
    const last = document.measures.indexOf(measures[measures.length - 1]);
    const nextMeasureId = document.measures[last + 1]?.id ?? null;
    const firstSignature = measures[0].timeSignature;
    const signatures = new Set(measures.map((m) => `${m.timeSignature.beats}/${m.timeSignature.beatValue}`));
    const commonSignature = signatures.size === 1 ? [...signatures][0] : null;

    // what the measures hold, on the staff the editor works on or on every staff: it replaces the pick of the measures themselves
    const selectContents = (staffId?: string) => {
      const groups = measureIds.map((id) => measureContentSelection(document, id, staffId));
      selectMany(groups.flatMap((g) => g.noteIds), false, groups.flatMap((g) => g.carrierIds), groups.flatMap((g) => g.structureIds));
    };

    body = (
      <>
        <ObjectHeader
          title={measures.length === 1 ? 'Measure' : `Measures · ${measures.length}`}
          sub={
            measures.length === 1
              ? `Bar ${document.measures.indexOf(measures[0]) + 1}${commonSignature ? ` · ${commonSignature}` : ''}`
              : `Bars ${document.measures.indexOf(measures[0]) + 1}–${last + 1}`
          }
        />

        <div className="props-section">
          <div className="props-section-label">Select contents</div>
          <div className="props-action-row">
            <button type="button" className="editor-action" onClick={() => selectContents(currentStaff)}>
              This staff
            </button>
            <button type="button" className="editor-action" onClick={() => selectContents()}>
              All staves
            </button>
          </div>
        </div>

        <div className="props-section">
          <div className="props-section-label">Time signature</div>
          <ChoiceGroup
            ariaLabel="Time signature"
            value={commonSignature}
            options={TIME_SIGNATURES.map(({ beats, beatValue }) => ({
              value: `${beats}/${beatValue}`,
              label: `${beats}/${beatValue}`,
            }))}
            onChange={(sig) => {
              const ts = TIME_SIGNATURES.find(({ beats, beatValue }) => `${beats}/${beatValue}` === sig)!;
              void dispatch({ type: 'changeTimeSignature', measureIds, beats: ts.beats, beatValue: ts.beatValue });
            }}
          />
        </div>

        <div className="props-section">
          <IntegerField label="Beats per measure" value={firstSignature.beats} min={1}
            onCommit={(beats) => void dispatch({ type: 'changeTimeSignature', measureIds, ...firstSignature, beats })} />
          <RhythmField label="Beat unit" value={{ value: firstSignature.beatValue, dots: firstSignature.dots ?? 0 }}
            onChange={(value) => void dispatch({ type: 'changeTimeSignature', measureIds, beats: firstSignature.beats, beatValue: value.value, dots: value.dots })} />
        </div>
        <div className="props-section">
          <div className="props-section-label">Insert measure</div>
          <div className="props-action-row">
            <button
              type="button"
              className="editor-action"
              onClick={() => void dispatch({ type: 'insertMeasure', beforeMeasureId: measureIds[0] })}
            >
              Before
            </button>
            <button
              type="button"
              className="editor-action"
              onClick={() => void dispatch({ type: 'insertMeasure', beforeMeasureId: nextMeasureId })}
            >
              After
            </button>
          </div>
        </div>

        <div className="props-section props-destructive">
          <button
            type="button"
            className="editor-action danger props-delete"
            onClick={() => {
              select(null);
              void dispatch({ type: 'deleteBatch', entityIds: measureIds });
            }}
          >
            {measures.length === 1 ? 'Remove measure' : `Remove ${measures.length} measures`}
          </button>
        </div>
      </>
    );
  } else if (selectedIds.length === 0) {
    // nothing selected: the plate hides, still showing what it last showed while it leaves
    panelKey = lastShown.current.key;
    body = lastShown.current.body;
  } else {
    const sel = describeSelection(document, selectedIds);
    const { carriers, noteCount, restCount } = sel;

    // What is selected, at a glance — drives the header + which detail rows to show.
    const singleCarrier = carriers.length === 1 ? carriers[0] : null;
    const isSingleNote = noteCount === 1 && restCount === 0 && carriers.length === 1;
    const isWholeChord =
      singleCarrier != null &&
      singleCarrier.item.kind === 'note' &&
      singleCarrier.whole &&
      singleCarrier.item.notes.length > 1;
    const isSingleRest = restCount === 1 && noteCount === 0 && carriers.length === 1;

    let heading: string;
    const carrierName = singleCarrier ? durationName(singleCarrier.item.duration, singleCarrier.item.dots) : '';
    // a grace carrier takes no time of its own and has no stem to edit; its value goes by its own command
    const isGrace = !!singleCarrier?.item.grace;
    const writeValue = (carrierId: string, writtenValue: { value: number; dots: number }) =>
      void dispatch(isGrace ? { type: 'changeGraceValue', carrierId, writtenValue } : { type: 'changeDuration', carrierId, writtenValue });
    if (isSingleRest) heading = `${carrierName} rest`;
    else if (isWholeChord) heading = `${carrierName} ${isGrace ? 'grace chord' : 'chord'}`;
    else if (isSingleNote) heading = `${carrierName} ${isGrace ? 'grace note' : 'note'}`;
    else heading = `Selection · ${noteCount + restCount}`;
    const markCount = structureCount + pickedContexts.length;
    if (markCount) heading += ` · ${markCount} marks`;
    // the animation key is the COARSE kind, not the exact heading (e.g. not the chord's note
    // count) — switching from a 2-note chord to a 3-note chord re-renders in place, only a real
    // kind change (note -> chord, chord -> rest, ...) crossfades.
    panelKey = isSingleRest ? 'rest' : isWholeChord ? 'chord' : isSingleNote ? 'note' : 'mixed';

    // Stem direction acts on every carrier-context (whole chord) in the selection — never a single
    // note. The active chip lights only when ALL of them agree, so a mixed set shows no active state.
    const stemmable = carriers.filter((c) => !c.item.grace && isStemCarrier(c, carrierSelectedIds));
    // `stemOverrides` is a partial map at runtime (absent = automatic), but its Record type reads
    // as always-present, so annotate the "auto" fallback explicitly to keep 0 in the union.
    const stemDirOf = (id: string): 1 | -1 | 0 => (stemOverrides[id]?.direction ?? 0) as 1 | -1 | 0;
    const stemDirs = new Set(stemmable.map((c) => stemDirOf(c.item.id)));
    const commonStemDir = stemDirs.size === 1 ? [...stemDirs][0] : null; // 1 up, -1 down, 0 auto, null mixed
    const setStemDir = (dir: 1 | -1 | null) =>
      void commitStems(
        stemmable.map((c) => c.item.id),
        dir === null ? null : { direction: dir, lengthFactor: 1 },
      );

    // Tie: exactly two notes on two neighbouring carriers of one voice — `carriers` is in document
    // order, so the first is the earlier. Beam: two or more whole carriers of one voice, in time
    // order. The backend still judges both (touching, beamable lengths) and explains a refusal.
    const sameVoice = carriers.every((c) => c.voiceId === carriers[0].voiceId);
    const voiceOrder = carriers.length ? orderedVoiceCarrierIds(document, carriers[0].voiceId) : [];
    const tie =
      noteCount === 2 &&
      restCount === 0 &&
      carriers.length === 2 &&
      sameVoice &&
      voiceOrder.indexOf(carriers[1].item.id) === voiceOrder.indexOf(carriers[0].item.id) + 1
        ? { startNoteId: carriers[0].notes[0].noteId, endNoteId: carriers[1].notes[0].noteId }
        : null;
    const splitBeam = carriers.length === 1 ? splitBeamTarget(document, carriers[0].item.id) : null;
    const beamIds =
      carriers.length >= 2 && sameVoice && carriers.every((c) => c.whole && !c.item.grace)
        && !document.beams.some(beam => beam.carrierIds.some(id => carriers.some(c => c.item.id === id)))
        ? carriers.map((c) => c.item.id) : null;

    const deleteLabel = markCount > 0 ? 'Delete selection' : isSingleRest
      ? 'Delete rest'
      : isWholeChord
        ? `Delete ${isGrace ? 'grace chord' : 'chord'}`
        : isSingleNote
          ? `Delete ${isGrace ? 'grace note' : 'note'}`
          : `Delete ${noteCount + restCount}`;

    body = (
      <>
        {/* ---- the object, named musically: glyph + "Quarter note" + "B4" ---- */}
        <ObjectHeader
          glyph={
            singleCarrier ? (
              <NotationIcon duration={singleCarrier.item.duration} rest={singleCarrier.item.kind === 'rest'} />
            ) : null
          }
          title={heading}
          sub={
            isSingleNote && singleCarrier
              ? spelledPitch(
                  singleCarrier.notes[0].staffStep,
                  new ContextIndex(document).clefNameAt(singleCarrier.notes[0].staffId, singleCarrier.measureId, singleCarrier.item.position),
                  singleCarrier.notes[0].accidental,
                )
              : isWholeChord && singleCarrier
                ? singleCarrier.item.notes
                    .map((n) => spelledPitch(n.staffStep, new ContextIndex(document).clefNameAt(n.staffId, singleCarrier.measureId, singleCarrier.item.position), n.accidental))
                    .join(' · ')
                : !singleCarrier
                  ? [noteCount > 0 ? `${noteCount} ${noteCount === 1 ? 'note' : 'notes'}` : '', restCount > 0 ? `${restCount} ${restCount === 1 ? 'rest' : 'rests'}` : '']
                      .filter(Boolean)
                      .join(' · ')
                  : ''
          }
        />

        {isSingleNote && singleCarrier && <div className="props-section">
          {singleCarrier.notes[0].midiNote != null && <p className="hp-note">Sounding MIDI note {singleCarrier.notes[0].midiNote}</p>}
          <IntegerField label="Staff step" value={singleCarrier.notes[0].staffStep}
            onCommit={(staffStep) => void dispatch({ type: 'changePitch', noteId: singleCarrier.notes[0].noteId, staffStep })} />
          <ChoiceGroup ariaLabel="Accidental" value={singleCarrier.notes[0].accidental ?? 'n'}
            options={[{ value: 'b', label: 'Flat' }, { value: 'n', label: 'Natural' }, { value: '#', label: 'Sharp' }]}
            onChange={(acc) => void dispatch({ type: 'setAccidental', noteId: singleCarrier.notes[0].noteId, accidental: acc === '#' ? 'sharp' : acc === 'b' ? 'flat' : 'natural' })} />
          <div className="props-staff">
            <span className="props-staff-name">{staffName(document.staffOrder, singleCarrier.notes[0].staffId)}</span>
            {document.staffOrder.filter((id) => id !== singleCarrier.notes[0].staffId).map((id) => (
              // a note moved to another staff keeps its sound: the question of the policy does not arise
              <button key={id} type="button" className="editor-action"
                onClick={() => void dispatch({ type: 'moveNoteToStaff', noteId: singleCarrier.notes[0].noteId, staffId: id, mode: 'preserve_pitch' }, 'preserve_pitch')}>
                Move to {staffName(document.staffOrder, id)}
              </button>
            ))}
          </div>
        </div>}
        {/* ---- duration: a carrier-level value, so one carrier at a time ---- */}
        {singleCarrier && (
          <div className="props-section">
            <div className="props-section-label">Duration</div>
            <ChoiceGroup
              ariaLabel="Duration"
              variant="glyph"
              value={singleCarrier.item.duration}
              // every written value the backend supports, the 32nd included
              options={NOTE_VALUES.map((value) => ({
                value,
                label: <ToolIcon id={value} />,
                ariaLabel: toolLabel(value),
                title: toolLabel(value),
              }))}
              onChange={(value) =>
                // a shorter value allows fewer dots: keep as many as it can carry
                writeValue(singleCarrier.item.id, { value: DURATION_VALUE[value], dots: Math.min(singleCarrier.item.dots, maxDots(value)) })
              }
            />
          </div>
        )}

        {/* ---- dots: how many, up to what the value can carry (each adds half of the previous) ---- */}
        {singleCarrier && maxDots(singleCarrier.item.duration) > 0 && (
          <div className="props-section">
            <div className="props-section-label">Dots</div>
            <ChoiceGroup
              ariaLabel="Dots"
              value={String(singleCarrier.item.dots)}
              options={Array.from({ length: maxDots(singleCarrier.item.duration) + 1 }, (_, count) => ({
                value: String(count),
                label: count === 0 ? 'None' : '•'.repeat(count),
                ariaLabel: count === 0 ? 'No dots' : count === 1 ? 'One dot' : `${count} dots`,
                title: count === 0 ? 'No dots' : count === 1 ? 'One dot' : `${count} dots`,
              }))}
              onChange={(count) =>
                writeValue(singleCarrier.item.id, { value: DURATION_VALUE[singleCarrier.item.duration], dots: Number(count) })
              }
            />
          </div>
        )}

        {/* ---- grace group: slashed or plain, for every grace carrier on that side of the note ---- */}
        {singleCarrier?.item.grace && (
          <div className="props-section">
            <div className="props-section-label">Grace kind</div>
            <ChoiceGroup
              ariaLabel="Grace kind"
              value={singleCarrier.item.grace.kind}
              options={[{ value: 'acciaccatura', label: 'Slashed' }, { value: 'appoggiatura', label: 'Plain' }]}
              onChange={(kind) => void dispatch({ type: 'changeGraceType', noteId: singleCarrier.notes[0]?.noteId ?? singleCarrier.item.notes[0].noteId, graceKind: kind as 'acciaccatura' | 'appoggiatura' })}
            />
          </div>
        )}

        {/* ---- fingering: per note ---- */}
        {isSingleNote && singleCarrier && (
          <div className="props-section">
            <div className="props-section-label">Fingering</div>
            <ChoiceGroup
              ariaLabel="Fingering"
              value={String(singleCarrier.notes[0].fingering ?? 0)}
              options={FINGERINGS.map((fingering) => ({
                value: String(fingering),
                label: fingering === 0 ? 'None' : String(fingering),
              }))}
              onChange={(f) => void dispatch({ type: 'setFingering', noteId: singleCarrier.notes[0].noteId, fingering: Number(f) })}
            />
          </div>
        )}

        {/* ---- marks of the carriers: a choice of at most one mark in each group, for the whole selection in ONE gesture ---- */}
        {(() => {
          const noteCarriers = carriers.filter((c) => c.item.kind === 'note' && c.whole);
          if (!noteCarriers.length) return null;
          // a carrier that only continues a tie keeps no marks of its own: they belong to the first note
          const tiedEnds = new Set(document.ties.map((t) => t.endNoteId));
          const targets = noteCarriers.filter((c) => !c.item.notes.every((n) => tiedEnds.has(n.noteId)));
          const skipped = noteCarriers.length - targets.length;
          // the value a group shows: the one every carrier has, or none chosen when they differ
          const common = <T extends string>(pick: (c: SelectedCarrier) => T): T | null => {
            const values = new Set(targets.map(pick));
            return values.size === 1 ? [...values][0] : null;
          };
          const apply = (item: (c: SelectedCarrier) => { articulations?: ArticulationMark[]; ornament?: OrnamentMark }) =>
            void dispatch({ type: 'setCarrierMarks', items: targets.map((c) => ({ carrierId: c.item.id, ...item(c) })) });
          return (
            <div className="props-section">
              <div className="props-section-label">Articulation</div>
              {!targets.length ? (
                <p className="props-note">Marks go on the first note of the tie.</p>
              ) : (
                <>
                  {ARTICULATION_GROUPS.filter((g) => g.category !== 'arpeggio' || targets.every((c) => c.item.notes.length > 1)).map((g) => (
                    <div key={g.category} className="props-group">
                      <span className="props-group-label">{g.label}</span>
                      <ChoiceGroup
                        ariaLabel={g.label}
                        value={common((c) => c.item.articulations.find((m) => g.marks.includes(m)) ?? 'none')}
                        options={[{ value: 'none', label: 'None' }, ...g.marks.map((m) => ({
                          value: m,
                          label: g.category === 'arpeggio' ? (m === 'arpeggio_up' ? 'Up' : 'Down') : <SmuflIcon codes={[ARTICULATION_GLYPH[m as keyof typeof ARTICULATION_GLYPH]]} />,
                          ariaLabel: ARTICULATION_LABEL[m],
                          title: ARTICULATION_LABEL[m],
                        }))]}
                        onChange={(v) => apply((c) => ({ articulations: withMark(c.item.articulations, g.category, v === 'none' ? null : (v as ArticulationMark)) }))}
                      />
                    </div>
                  ))}
                  <div className="props-group">
                    <span className="props-group-label">Ornament</span>
                    <ChoiceGroup
                      ariaLabel="Ornament"
                      variant="wrap"
                      value={common((c) => c.item.ornament ?? 'none')}
                      options={[{ value: 'none', label: 'None' }, ...ORNAMENT_SIGNS.map((o) => ({ value: o.value, label: <SmuflIcon codes={o.glyphs} stack={o.glyphs.length > 1} />, ariaLabel: o.label, title: o.label }))]}
                      onChange={(v) => apply(() => ({ ornament: v as OrnamentMark }))}
                    />
                  </div>
                  {skipped > 0 && <p className="props-note">{skipped} of the selected continue a tie and are left out.</p>}
                </>
              )}
            </div>
          );
        })()}

        {/* ---- connect: tie two neighbouring notes, beam carriers ---- */}
        {(tie || beamIds || splitBeam || beams.length > 0) && (
          <div className="props-section">
            <div className="props-section-label">Connect</div>
            <div className="props-action-row">
              {tie && (
                <button type="button" className="editor-action" onClick={() => void dispatch({ type: 'tieNotes', ...tie })}>
                  Tie notes
                </button>
              )}
              {tie && !document.glissandos.some((g) => g.startNoteId === tie.startNoteId) && (['straight', 'wavy'] as const).map((glissandoType) => (
                <button key={glissandoType} type="button" className="editor-action" onClick={() => void dispatch({ type: 'glissandoNotes', ...tie, glissandoType })}>
                  {glissandoType === 'wavy' ? 'Wavy glissando' : 'Glissando'}
                </button>
              ))}
              {splitBeam && (
                <button type="button" className="editor-action" onClick={() => void dispatch({ type: 'splitBeam', ...splitBeam })}>
                  {isSingleRest ? 'Break beam before this rest' : 'Break beam before this note'}
                </button>
              )}
              {beams.length > 0 && (
                <button type="button" className="editor-action" onClick={() => void dispatch({ type: 'deleteBatch', entityIds: beams.map(beam => beam.id) })}>
                  {beams.length === 1 ? 'Remove beam' : 'Remove beams'}
                </button>
              )}
              {beamIds && (
                <button type="button" className="editor-action" onClick={() => void dispatch({ type: 'createBeam', carrierIds: beamIds })}>
                  Beam
                </button>
              )}
            </div>
          </div>
        )}

        {/* ---- stem direction (client-side) ---- */}
        {stemmable.length > 0 && (
          <div className="props-section">
            <div className="props-section-label">Stem</div>
            <ChoiceGroup
              ariaLabel="Stem"
              value={commonStemDir === null ? null : commonStemDir === 0 ? 'auto' : commonStemDir === 1 ? 'up' : 'down'}
              options={STEM_DIRECTIONS}
              onChange={(dir) => setStemDir(dir === 'auto' ? null : dir === 'up' ? 1 : -1)}
            />
          </div>
        )}

        {/* ---- destructive: set apart from the edits above ---- */}
        <div className="props-section props-destructive">
          <button type="button" className="editor-action danger props-delete" onClick={() => void deleteSelected()}>
            {deleteLabel}
          </button>
        </div>
      </>
    );
  }

  const open = measures.length > 0 || selectedIds.length > 0 || structureCount > 0 || pickedContexts.length > 0;
  if (open) lastShown.current = { key: panelKey, body };

  const { visual } = useLayoutSafeSpring(open, {
    visualSpring: SPRING_PANEL_BOUNCE,
    openVelocity: OPEN_OVERSHOOT_VELOCITY,
    closeVelocity: CLOSE_ANTICIPATE_VELOCITY,
  });
  // CSS turns the one progress value into the right motion per layout: a slide in from the right
  // edge of the lane, or a rise from the dock for the bottom sheet (index.css `.inspector`)
  const opacity = useTransform(visual, [0, 0.5], [0, 1]);

  // hidden = out of the tab order and the accessibility tree too. The plate's height is published
  // on the editor root so the toast and the sheet's scroll room can clear the bottom sheet.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || placement === 'rail') return;
    panel.inert = !open;
    const root = panel.closest<HTMLElement>('.editor-screen');
    if (!root) return;
    // a measured height (px: a measurement handed back to CSS, not an authored length)
    const publish = () => root.style.setProperty('--inspector-h', open ? `${panel.offsetHeight}px` : '0px');
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(panel);
    return () => ro.disconnect();
  }, [open, placement]);

  if (placement === 'rail') {
    return (
      <section className="inspector inspector--rail" aria-label="Inspector">
        <div className="inspector-body">
          <FadeSwap stateKey={panelKey}>
            <div className="props-content">{body}</div>
          </FadeSwap>
        </div>
      </section>
    );
  }

  return (
    <motion.aside
      ref={panelRef}
      className="inspector"
      aria-label="Inspector"
      data-occludes-canvas
      data-open={open}
      style={{ '--inspector-p': visual, opacity } as unknown as CSSProperties}
    >
      <div className="inspector-body">
        <FadeSwap stateKey={panelKey}>
          <div className="props-content">{body}</div>
        </FadeSwap>
      </div>
    </motion.aside>
  );
}

/** The inspector's header: the object's own VexFlow glyph on a small plate, its musical name, and
 *  the detail a musician reads first (spelled pitch, bar number). */
