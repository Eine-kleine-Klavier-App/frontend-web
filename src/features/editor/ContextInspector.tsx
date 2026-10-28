import { bodyFactor } from '@/core/model/presentation';
import { useRef, useState, type ReactNode } from 'react';
import { useEditor } from '@/app/store';
import { IntegerField, PitchPolicyField, RhythmField } from './EditorFields';
import { KeySignatureChoices } from './icons';
import { VoltaPassesTable } from './VoltaPassesTable';
import { CloseIcon } from '@/ui/icons';
import { ChoiceGroup } from '@/ui/ChoiceGroup';
import { MultiChoice } from '@/ui/MultiChoice';
import { alterationsOfFifths, keyOfAlterations, ContextIndex, toBeats } from '@/core/model/contexts';
import { derivedEnding } from '@/core/model/repeats';
import type {
  ClefContext,
  Dynamic,
  DynamicContext,
  HairpinContext,
  KeySignatureContext,
  OctaveContext,
  PitchMode,
  RefrainContext,
  ScoreContext,
  ScoreDocument,
  SlurContext,
  TempoContext,
  TempoTransitionContext,
  VoltaContext,
} from '@/core/model/score';

// The inspector's body for a picked context (clef, key signature, dynamic, tempo, hairpin, slur,
// octave line, tempo transition): what it is, the controls the backend offers for it, and its
// removal. Every control is one backend command; the score's own opening clef, key, tempo and
// dynamics cannot be removed, so they offer no Remove.

export const DYNAMICS: Dynamic[] = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** the score opens with a clef, key, tempo and dynamics: those are not removable or movable */
function isOpening(doc: ScoreDocument, c: ScoreContext): boolean {
  return c.measureId === doc.measures[0]?.id && toBeats(c.position) === 0 && ['clef', 'keySignature', 'tempo', 'dynamic'].includes(c.kind);
}

export function ObjectHeader({ glyph, title, sub }: { glyph?: ReactNode; title: string; sub?: string }) {
  const select = useEditor((s) => s.select);
  return (
    <div className="object-header">
      {glyph && <span className="object-glyph">{glyph}</span>}
      <div className="object-name">
        <h3>{title}</h3>
        {sub && <span>{sub}</span>}
      </div>
      <button type="button" className="icon-btn ghost object-clear" aria-label="Clear selection" onClick={() => select(null)}>
        <CloseIcon />
      </button>
    </div>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="props-section props-destructive">
      <button type="button" className="editor-action danger props-delete" onClick={onClick}>
        {label}
      </button>
    </div>
  );
}

function NumberField({ id, label, value, min, max, onCommit }: { id: string; label: string; value: number | null; min: number; max?: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(value === null ? '' : String(value));
  }
  const commit = () => {
    const n = Math.round(Number(draft));
    if (Number.isFinite(n) && n >= min && (max === undefined || n <= max) && n !== value) onCommit(n);
    else setDraft(value === null ? '' : String(value));
  };
  return (
    <label className="props-number" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          e.stopPropagation(); // typing a number must not trigger the editor's hotkeys
        }}
      />
    </label>
  );
}

export function ContextInspector({ context }: { context: ScoreContext }) {
  return <ContextBody key={context.id} context={context} />;
}

function ContextBody({ context }: { context: ScoreContext }) {
  const doc = useEditor((s) => s.document);
  const dispatch = useEditor((s) => s.dispatch);
  const select = useEditor((s) => s.select);
  const mode = useEditor((s) => s.pitchMode);

  const setFactor = useEditor((s) => s.setContextFactor);
  const removable = !isOpening(doc, context);
  const [dynamicUpdating, setDynamicUpdating] = useState(false);
  const dynamicPending = useRef(false);
  const setSharedDynamic = async (dynamic: Dynamic, voiceIds: string[]) => {
    if (context.kind !== 'dynamic' || dynamicPending.current) return;
    dynamicPending.current = true;
    setDynamicUpdating(true);
    try {
      await dispatch({ type: 'setDynamic', measureId: context.measureId, position: context.position, voiceIds, dynamic });
      const state = useEditor.getState();
      if (state.error) return;
      const replacement = state.document.contexts.find((c) => c.kind === 'dynamic' && c.measureId === context.measureId
        && toBeats(c.position) === toBeats(context.position) && c.dynamic === dynamic
        && voiceIds.every((id) => c.voiceIds.includes(id)));
      if (replacement) state.selectStructure(replacement.id, false);
    } finally {
      dynamicPending.current = false;
      setDynamicUpdating(false);
    }
  };
  const remove = () => {
    select(null);
    void dispatch({ type: 'deleteBatch', entityIds: [context.id] });
  };
  const resetHeight = bodyFactor(doc.presentation, context.id) !== 1 ? (
    <div className="props-section">
      <button type="button" className="editor-action props-delete" onClick={() => setFactor(context.id, 1)}>
        Reset height
      </button>
    </div>
  ) : null;

  switch (context.kind) {
    case 'dynamic':
      return (
        <>
          <ObjectHeader title={`Dynamic ${context.dynamic}`} sub={voiceLabel(doc, context.voiceIds)} />
          <div className="props-section">
            <div className="props-section-label">Level</div>
            <ChoiceGroup<Dynamic>
              ariaLabel="Dynamic level"
              variant="wrap"
              value={context.dynamic}
              options={DYNAMICS.map((d) => ({ value: d, label: <i className="dynamic-label">{d}</i> }))}
              onChange={(dynamic) => void setSharedDynamic(dynamic, context.voiceIds)}
            />
          </div>
          <ContextVoices context={context} busy={dynamicUpdating} onShareDynamic={voiceIds => setSharedDynamic(context.dynamic, voiceIds)} />
          {resetHeight}
          {removable && <RemoveButton label="Remove dynamic" onClick={remove} />}
        </>
      );
    case 'hairpin':
      return <HairpinBody context={context} resetHeight={resetHeight} onRemove={remove} />;
    case 'refrain':
      return <RefrainBody context={context} onRemove={remove} />;
    case 'volta':
      return <VoltaBody context={context} onRemove={remove} />;
    case 'sustain':
      return <><ObjectHeader title="Sustain pedal" /><RemoveButton label="Remove pedal" onClick={remove} /></>;
    case 'slur':
      return (
        <>
          <ObjectHeader title="Slur" sub={voiceLabel(doc, context.voiceIds)} />
          <ContextVoices context={context} />
          <RemoveButton label="Remove slur" onClick={remove} />
        </>
      );
    case 'octave':
      return <OctaveBody context={context} mode={mode} />;
    case 'tempo':
      return <TempoBody context={context} resetHeight={resetHeight} removable={removable} onRemove={remove} />;
    case 'tempoTransition':
      return <TransitionBody context={context} resetHeight={resetHeight} onRemove={remove} />;
    case 'clef':
      return <ClefBody context={context} removable={removable} />;
    case 'keySignature':
      return <KeyBody context={context} removable={removable} onRemove={remove} />;
  }
}

/** The last voice stays; opening dynamics keep every voice they already cover. */
function ContextVoices({ context, busy = false, onShareDynamic }: {
  context: DynamicContext | HairpinContext | SlurContext;
  busy?: boolean;
  onShareDynamic?: (voiceIds: string[]) => Promise<void>;
}) {
  const doc = useEditor((s) => s.document);
  const dispatch = useEditor((s) => s.dispatch);
  const [updating, setUpdating] = useState(false);
  const pending = useRef(false);
  const opening: boolean = context.kind === 'dynamic' && isOpening(doc, context);
  const reason: string = context.voiceIds.length <= 1 ? 'A context keeps at least one voice.'
    : opening ? 'The dynamic the score opens with keeps its voices.' : '';
  const change = async (voiceIds: string[]) => {
    if (pending.current || busy) return;
    const added = voiceIds.find(id => !context.voiceIds.includes(id));
    const removed = context.voiceIds.find(id => !voiceIds.includes(id));
    const voiceId = added ?? removed;
    if (!voiceId) return;
    pending.current = true;
    setUpdating(true);
    try {
      if (context.kind === 'dynamic' && added && onShareDynamic) await onShareDynamic(voiceIds);
      else await dispatch({ type: added ? 'addContextVoice' : 'removeContextVoice', contextId: context.id, voiceId });
    } finally {
      pending.current = false;
      setUpdating(false);
    }
  };
  return <fieldset className="editor-fields">
    <legend>Voices</legend>
    <MultiChoice ariaLabel="Voices" value={context.voiceIds} disabled={updating || busy} onChange={voiceIds => void change(voiceIds)}
      options={doc.voices.map(voice => ({ value: voice.id, label: `Voice ${voice.index + 1}`,
        disabled: context.voiceIds.includes(voice.id) && !!reason, title: context.voiceIds.includes(voice.id) && reason ? reason : undefined }))} />
    {reason && <p className="hp-note">{reason}</p>}
  </fieldset>;
}

/** A repeat: how many times its stretch is played. The signs and the words over them are engraved in the score. */
function RefrainBody({ context, onRemove }: { context: RefrainContext; onRemove: () => void }) {
  const dispatch = useEditor((s) => s.dispatch);
  const doc = useEditor((s) => s.document);
  // the first ending is the bar right after the repeat; with no bar after it the ending lasts to the end of the score, and a repeat that
  // lasts there has no bar for an ending
  const endIndex = context.endMeasureId === null ? -1 : doc.measures.findIndex((measure) => measure.id === context.endMeasureId);
  const afterEnding = doc.measures[endIndex + 1];
  const addEnding = () => void dispatch({
    type: 'addRefrainEnding',
    refrainId: context.id,
    end: afterEnding ? { measureId: afterEnding.id, position: { numerator: 0, denominator: 1 } } : null,
  });
  return (
    <>
      <ObjectHeader title="Repeat" />
      <div className="props-section">
        <IntegerField label="Times played" value={context.times} min={2}
          onCommit={(times) => void dispatch({ type: 'setRefrainTimes', refrainId: context.id, times })} />
      </div>
      <div className="props-section">
        <button type="button" className="editor-action props-delete" disabled={endIndex < 0}
          title={endIndex < 0 ? 'A repeat that lasts to the end of the score has no bar for an ending.' : undefined} onClick={addEnding}>
          Add ending
        </button>
      </div>
      <RemoveButton label="Remove repeat" onClick={onRemove} />
    </>
  );
}

/** The endings of a repeat. Each stored ending says in which passes it is played; naming a pass takes it from the ending that had it,
 *  and the first ending is played in whatever the others leave. The last ending is the last pass, worked out, so it is only shown. */
function VoltaBody({ context, onRemove }: { context: VoltaContext; onRemove: () => void }) {
  const dispatch = useEditor((s) => s.dispatch);
  const doc = useEditor((s) => s.document);
  const [updating, setUpdating] = useState(false);
  const pending = useRef(false);
  const run = async (command: Parameters<typeof dispatch>[0]) => {
    if (pending.current) return;
    pending.current = true;
    setUpdating(true);
    try {
      await dispatch(command);
    } finally {
      pending.current = false;
      setUpdating(false);
    }
  };
  // the bar the last ending is over becomes the next ending, and the one after it the last; with none after it the new ending lasts to the
  // end of the score, and an ending that already lasts there leaves no bar to add one over
  const derived = derivedEnding(doc, context);
  const setPasses = (fragment: number, passes: number[]) => void run({ type: 'setVoltaFragmentPasses', voltaId: context.id, fragment, passes: [...passes].sort((a, z) => a - z) });
  const addEnding = () => derived && void run({ type: 'appendVoltaFragment', voltaId: context.id, end: derived.end });
  return (
    <>
      <ObjectHeader title="Endings" />
      <div className="props-section">
        <VoltaPassesTable context={context} busy={updating} canAdd={derived !== null} onSetPasses={setPasses} onAddEnding={addEnding}
          onTimes={(times) => void run({ type: 'setVoltaTimes', voltaId: context.id, times })} />
      </div>
      <RemoveButton label="Remove endings" onClick={onRemove} />
    </>
  );
}

function voiceLabel(doc: ScoreDocument, voiceIds: string[]): string {
  const names = voiceIds.map((id) => doc.voices.findIndex((v) => v.id === id) + 1).filter((n) => n > 0);
  return names.length ? `Voice ${names.join(', ')}` : '';
}

function HairpinBody({ context, resetHeight, onRemove }: { context: HairpinContext; resetHeight: ReactNode; onRemove: () => void }) {
  const dispatch = useEditor((s) => s.dispatch);
  const level = context.levels[0];
  const doc = useEditor((s) => s.document);
  const sameTarget = context.levels.every((item) => item.to === level?.to);
  return (
    <>
      <ObjectHeader title={context.type === 'crescendo' ? 'Crescendo' : 'Diminuendo'} sub={context.levels.map((item) => `${voiceLabel(doc, [item.voiceId])}: ${item.from} → ${item.to}`).join(" · ")} />
      <div className="props-section">
        <div className="props-section-label">Ends on</div>
        <ChoiceGroup<Dynamic>
          ariaLabel="Hairpin target"
          variant="wrap"
          value={sameTarget ? level?.to ?? null : null}
          options={DYNAMICS.map((d) => ({ value: d, label: <i className="dynamic-label">{d}</i> }))}
          onChange={(target) => void dispatch({ type: 'setHairpinTarget', hairpinId: context.id, target })}
        />
      </div>
      <ContextVoices context={context} />
      {resetHeight}
      <RemoveButton label="Remove hairpin" onClick={onRemove} />
    </>
  );
}

function OctaveBody({ context, mode }: { context: OctaveContext; mode: PitchMode }) {
  const dispatch = useEditor((s) => s.dispatch);
  const name = ({ 1: '8va', 2: '15ma', '-1': '8vb', '-2': '15mb' } as Record<string, string>)[String(context.octaves)] ?? `${context.octaves} octaves`;
  return (
    <>
      <ObjectHeader title={`Octave line ${name}`} />
      <PitchPolicyField what="Notes under this line" />
      <RemoveButton label="Remove octave line" onClick={() => void dispatch({ type: 'deleteOctaveTransposition', octaveId: context.id, mode })} />
    </>
  );
}

function TempoBody({ context, resetHeight, removable, onRemove }: { context: TempoContext; resetHeight: ReactNode; removable: boolean; onRemove: () => void }) {
  const dispatch = useEditor((s) => s.dispatch);
  const set = (patch: Partial<Pick<TempoContext, 'beat' | 'bpm' | 'showLabel'>>) => {
    const next = { beat: context.beat, bpm: context.bpm, showLabel: context.showLabel, ...patch };
    void dispatch({ type: 'setTempo', measureId: context.measureId, position: context.position,
      beat: next.beat ?? { value: 4, dots: 0 }, bpm: next.bpm, showLabel: next.showLabel });
  };
  return (
    <>
      <ObjectHeader title="Tempo" sub={[context.label && capital(context.label), context.bpm !== null && `1/${context.beat?.value ?? 4}${"·".repeat(context.beat?.dots ?? 0)} = ${context.bpm}`].filter(Boolean).join(' · ')} />
      <div className="props-section">
        <div className="props-section-label">Beats per minute</div>
        <NumberField id="tempo-bpm" label={`1/${context.beat?.value ?? 4}${"·".repeat(context.beat?.dots ?? 0)} =`} value={context.bpm} min={1} onCommit={(bpm) => set({ bpm })} />
      </div>
      <RhythmField label="Tempo beat" value={context.beat ?? { value: 4, dots: 0 }} onChange={(beat) => set({ beat })} />
      <div className="props-section"><label className="tempo-label-toggle">
        <input type="checkbox" checked={context.showLabel} onChange={(e) => set({ showLabel: e.target.checked })} />
        Show tempo name
      </label></div>
      {resetHeight}
      {removable && <RemoveButton label="Remove tempo" onClick={onRemove} />}
    </>
  );
}

function TransitionBody({ context, resetHeight, onRemove }: { context: TempoTransitionContext; resetHeight: ReactNode; onRemove: () => void }) {
  const dispatch = useEditor((s) => s.dispatch);
  const slower = context.endBpm !== null && context.startBpm !== null ? context.endBpm < context.startBpm : true;
  return (
    <>
      <ObjectHeader title={slower ? 'Ritardando' : 'Accelerando'} sub={context.startBpm !== null && context.endBpm !== null ? `1/${context.startTempo?.beat.value ?? 4}${"·".repeat(context.startTempo?.beat.dots ?? 0)} = ${context.startBpm} → ${context.endBpm}` : undefined} />
      <div className="props-section">
        <div className="props-section-label">Ends at</div>
        <NumberField id="transition-target" label={`1/${context.startTempo?.beat.value ?? 4}${"·".repeat(context.startTempo?.beat.dots ?? 0)} =`} value={context.endBpm} min={1} onCommit={(targetBpm) => void dispatch({ type: 'setTempoTransitionTarget', transitionId: context.id, targetBpm })} />
      </div>
      {resetHeight}
      <RemoveButton label="Remove transition" onClick={onRemove} />
    </>
  );
}

function ClefBody({ context, removable }: { context: ClefContext; removable: boolean }) {
  const [lastMeasure, setLastMeasure] = useState(context.measureId);
  const doc = useEditor((s) => s.document);
  const dispatch = useEditor((s) => s.dispatch);
  const mode = useEditor((s) => s.pitchMode);
  const set = (patch: Partial<Pick<ClefContext, 'clef' | 'octaveTransposition'>>) =>
    void dispatch({
      type: 'setClef',
      staffId: context.staffId,
      measureId: context.measureId,
      position: context.position,
      clef: patch.clef ?? context.clef,
      octaveTransposition: patch.octaveTransposition ?? context.octaveTransposition,
      mode,
    });
  const staffName = doc.staffOrder.indexOf(context.staffId) === 0 ? 'Upper staff' : 'Lower staff';
  return (
    <>
      <ObjectHeader title={`${capital(context.clef)} clef`} sub={staffName} />
      <div className="props-section">
        <div className="props-section-label">Clef</div>
        <ChoiceGroup<'treble' | 'bass'>
          ariaLabel="Clef"
          value={context.clef}
          options={[{ value: 'treble', label: 'Treble' }, { value: 'bass', label: 'Bass' }]}
          onChange={(clef) => set({ clef })}
        />
      </div>
      <div className="props-section">
        <div className="props-section-label">Octave</div>
        <ChoiceGroup<string>
          ariaLabel="Clef octave"
          value={String(context.octaveTransposition)}
          options={[{ value: '-1', label: '8vb' }, { value: '0', label: 'Normal' }, { value: '1', label: '8va' }]}
          onChange={(o) => set({ octaveTransposition: Number(o) })}
        />
      </div>
      <PitchPolicyField what="Notes on this staff" />
      {removable && <label className="editor-field-label">Remove through measure<select value={lastMeasure}
        onChange={(e) => setLastMeasure(e.target.value)}>
        {doc.measures.slice(doc.measures.findIndex((m) => m.id === context.measureId)).map((m) =>
          <option key={m.id} value={m.id}>Bar {doc.measures.indexOf(m) + 1}</option>)}
      </select></label>}
      {removable && (
        <RemoveButton
          label="Remove clef"
          onClick={() => {
            useEditor.getState().select(null);
            void dispatch({ type: 'deleteClef', clefId: context.id, measureIds: doc.measures.slice(doc.measures.findIndex((m) => m.id === context.measureId), doc.measures.findIndex((m) => m.id === lastMeasure) + 1).map((m) => m.id), mode });
          }}
        />
      )}
    </>
  );
}

function KeyBody({ context, removable, onRemove }: { context: KeySignatureContext; removable: boolean; onRemove: () => void }) {
  const doc = useEditor((s) => s.document);
  const dispatch = useEditor((s) => s.dispatch);
  const current = keyOfAlterations(context.alterations);
  const staffName = doc.staffOrder.indexOf(context.staffId) === 0 ? 'Upper staff' : 'Lower staff';
  return (
    <>
      <ObjectHeader title="Key signature" sub={`${current.standard === false ? "Custom key" : `${current.name} major`} · ${staffName}`} />
      <div className="props-section">
        <KeySignatureChoices value={current.standard === false ? null : current.fifths}
          clef={new ContextIndex(doc).clefAt(context.staffId, context.measureId, toBeats(context.position))?.clef ?? 'treble'}
          onChange={(fifths) => void dispatch({ type: 'setKeySignature', staffId: context.staffId, measureId: context.measureId,
            position: context.position, alterations: alterationsOfFifths(fifths) })} />
      </div>
      {removable && <RemoveButton label="Remove key change" onClick={onRemove} />}
    </>
  );
}
