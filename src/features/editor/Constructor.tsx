import { IntegerField, RhythmField, VoicesField } from './EditorFields';
import { DYNAMICS } from './ContextInspector';
import type { Dynamic, RhythmicValue } from '@/core/model/score';
import { isSpanMark, type MarkSpec } from '@/core/model/markTools';
import { useState, type ReactNode } from 'react';
import { useEditor, hotbarSlotKey } from '@/app/store';
import { ChoiceGroup } from '@/ui/ChoiceGroup';
import { PinIcon } from '@/ui/icons';
import { NOTE_VALUES, toolId, toolLabel, type InsertSpec } from '@/core/model/insertItems';
import type { Accidental, ArticulationMark, DurationValue } from '@/core/model/score';
import { ARTICULATION_GROUPS, ARTICULATION_LABEL, withMark } from '@/core/model/articulation';
import { alterationsOfFifths } from '@/core/model/contexts';
import { markToolId } from '@/core/model/markTools';
import { KeySignatureChoices, SmuflIcon, ToolIcon } from './icons';
import {
  ACCIDENTAL_GLYPH,
  ARTICULATION_GLYPH,
  beginToolDrag,
  endToolDrag,
  type BuildPreset,
  type ConstructorMode,
} from './libraryItems';

// The Build tab: everything the backend can insert, in modes — a note composite (value, dots,
// articulation, accidental), a rest, a tuplet n:m (count, in the time of, value, first element), a
// time signature n/m and the marks. Previewed on paper, engraved by VexFlow. Insert arms it as the
// insert tool; Pin puts it in the first empty hotbar slot (or drag the preview onto any slot).

/** the note composite's marks: the length and the loudness groups (an arpeggio is set on a chord) */
const MARK_GROUPS = ARTICULATION_GROUPS.filter((g) => g.category !== 'arpeggio').map((g) => ({
  ...g,
  options: [
    { value: 'none', label: 'None' },
    ...(g.marks as (keyof typeof ARTICULATION_GLYPH)[]).map((m) => ({ value: m, label: <SmuflIcon codes={[ARTICULATION_GLYPH[m]]} />, ariaLabel: ARTICULATION_LABEL[m] })),
  ],
}));
const ACCIDENTAL_OPTIONS = [
  { value: '', label: 'None' },
  ...(['#', 'b', 'n'] as const).map((acc) => ({
    value: acc,
    label: <SmuflIcon codes={[ACCIDENTAL_GLYPH[acc]]} />,
    ariaLabel: acc === '#' ? 'Sharp' : acc === 'b' ? 'Flat' : 'Natural',
  })),
];
const MODE_OPTIONS: { value: ConstructorMode; label: string }[] = [
  { value: 'note', label: 'Note' },
  { value: 'rest', label: 'Rest' },
  { value: 'tuplet', label: 'Tuplet' },
  { value: 'timesig', label: 'Metre' },
  { value: 'mark', label: 'Mark' },
];
const FIRST_OPTIONS = [
  { value: 'note', label: 'Note' },
  { value: 'rest', label: 'Rest' },
];
const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="props-section">
    <div className="props-section-label">{label}</div>
    {children}
  </div>
);

export function Constructor({ preset }: { preset: BuildPreset }) {
  const [mode, setMode] = useState<ConstructorMode>(preset.mode ?? 'note');
  const [note, setNote] = useState({
    value: preset.value ?? ('q' as DurationValue),
    dots: preset.dots ?? 0,
    articulations: preset.articulations ?? ([] as ArticulationMark[]),
    accidental: preset.accidental ?? (null as Accidental),
    fingering: preset.fingering ?? 0,
  });
  const [tuplet, setTuplet] = useState({ n: 3, m: 2, value: '8' as DurationValue, first: 'note' as 'note' | 'rest' });
  const [metre, setMetre] = useState({ beats: 5, beatValue: 4, dots: 0 });
  const [written, setWritten] = useState<RhythmicValue>({ value: 8, dots: 0 });
  const [occupied, setOccupied] = useState<RhythmicValue>({ value: 8, dots: 0 });
  const [firstValue, setFirstValue] = useState<RhythmicValue>({ value: 8, dots: 0 });
  const setTool = useEditor((s) => s.setTool);
  const tool = useEditor((s) => s.tool);
  const hotbarSlots = useEditor((s) => s.hotbarSlots);
  const setHotbarSlot = useEditor((s) => s.setHotbarSlot);
  const [full, setFull] = useState(false);

  const spec: InsertSpec =
    (mode === 'note' || mode === 'rest')
      ? { kind: mode, ...note, articulations: mode === 'rest' ? [] : note.articulations }
      : mode === 'tuplet'
        ? { kind: 'tuplet', value: NOTE_VALUES.find((v) => ({ w: 1, h: 2, q: 4, '8': 8, '16': 16, '32': 32 }[v]) === firstValue.value)!, dots: firstValue.dots, articulations: [], accidental: note.accidental, fingering: note.fingering, tuplet: { n: tuplet.n, m: tuplet.m, first: tuplet.first, written: { value: written, count: tuplet.n }, occupied: { value: occupied, count: tuplet.m } } }
        : { kind: 'timesig', value: 'q', dots: 0, articulations: [], accidental: null, timeSignature: metre };
  const id = toolId(spec);
  const slot = hotbarSlots.indexOf(id);
  const armed = tool === id;

  const empty = hotbarSlots.indexOf(null);
  const save = () => {
    if (slot >= 0) return;
    if (empty < 0) return setFull(true);
    setFull(false);
    setHotbarSlot(empty, id);
  };

  const noteFields = (
    <>
      <RhythmField label="Duration" value={{ value: { w: 1, h: 2, q: 4, '8': 8, '16': 16, '32': 32 }[note.value], dots: note.dots }}
        onChange={(v) => setNote({ ...note, value: NOTE_VALUES.find((n) => ({ w:1,h:2,q:4,'8':8,'16':16,'32':32 }[n]) === v.value)!, dots: v.dots })} />
      {mode !== 'rest' && <IntegerField label="Fingering" value={note.fingering} min={0} max={5} onCommit={(fingering) => setNote({ ...note, fingering })} />}
      {MARK_GROUPS.map((g) => (
        <Field key={g.category} label={g.label}>
          <ChoiceGroup
            ariaLabel={g.label}
            value={note.articulations.find((m) => g.marks.includes(m)) ?? 'none'}
            options={g.options}
            onChange={(v) => setNote({ ...note, articulations: withMark(note.articulations, g.category, v === 'none' ? null : (v as ArticulationMark)) })}
          />
        </Field>
      ))}
      <Field label="Accidental">
        <ChoiceGroup ariaLabel="Accidental" value={note.accidental ?? ''} options={ACCIDENTAL_OPTIONS} onChange={(acc) => setNote({ ...note, accidental: (acc || null) as Accidental })} />
      </Field>
    </>
  );
  const tupletFields = (
    <>
      <div className="hp-pair">
        <Field label="Count">
          <IntegerField label="Count" value={tuplet.n} min={1} onCommit={(n) => setTuplet({ ...tuplet, n })} />
        </Field>
        <Field label="In the time of">
          <IntegerField label="In the time of" value={tuplet.m} min={1} onCommit={(m) => setTuplet({ ...tuplet, m })} />
        </Field>
      </div>
      <RhythmField label="Written unit" value={written} onChange={setWritten} />
      <RhythmField label="Occupied unit" value={occupied} onChange={setOccupied} />
      <RhythmField label="First element duration" value={firstValue} onChange={setFirstValue} />
      <IntegerField label="Fingering" value={note.fingering} min={0} max={5} onCommit={(fingering) => setNote({ ...note, fingering })} />
      <ChoiceGroup ariaLabel="First note accidental" value={note.accidental ?? ''} options={ACCIDENTAL_OPTIONS}
        onChange={(acc) => setNote({ ...note, accidental: (acc || null) as Accidental })} />
      <Field label="First element">
        <ChoiceGroup ariaLabel="First element" value={tuplet.first} options={FIRST_OPTIONS} onChange={(first) => setTuplet({ ...tuplet, first: first as 'note' | 'rest' })} />
      </Field>
    </>
  );
  const metreFields = (
    <>
      <Field label="Beats">
        <IntegerField label="Beats" value={metre.beats} min={1} onCommit={(beats) => setMetre({ ...metre, beats })} />
      </Field>
      <RhythmField label="Beat unit" value={{ value: metre.beatValue, dots: metre.dots }} onChange={(v) => setMetre({ ...metre, beatValue: v.value, dots: v.dots })} />
    </>
  );

  const hint = armed
    ? mode === 'timesig'
      ? 'Click a measure to set its time signature.'
      : 'Click on the staff to place it.'
    : mode === 'note' && note.articulations.length
      ? 'Places the note, then sets its marks: two backend commands today (no composite intent yet), so two undo steps.'
      : mode === 'tuplet'
        ? `The tuplet starts where you click, its first element a ${tuplet.first}; the backend fills the rest with rests.`
        : mode === 'timesig'
          ? 'Arms it; then click the measure it applies to.'
          : 'Arms it as the insert tool; click on the staff to place it.';

  const modes = <ChoiceGroup ariaLabel="What to build" variant="wrap" value={mode} options={MODE_OPTIONS} onChange={(m) => setMode(m)} />;

  if (mode === 'mark') return <div className="hp-build">
    <div className="hp-build-modes">{modes}</div>
    <MarkConstructor />
  </div>;

  return (
    <div className="hp-build">
      <div className="hp-build-modes">{modes}</div>
      <div className="hp-scroll">
        <div
          className="hp-preview"
          aria-label={`Preview: ${toolLabel(id)}`}
          title="Drag onto a hotbar slot"
          draggable
          onDragStart={(e) => beginToolDrag(e, id)}
          onDragEnd={endToolDrag}
        >
          <ToolIcon id={id} />
        </div>
        <p className="hp-preview-name">{toolLabel(id)}</p>
        {mode === 'note' || mode === 'rest' ? noteFields : mode === 'tuplet' ? tupletFields : metreFields}
        <p className="hp-note" aria-live="polite">
          {full && slot < 0 ? 'All ten slots are full: drag the preview onto the slot to replace.' : hint}
        </p>
      </div>
      <div className="hp-footer hp-actions">
        <button type="button" className={'editor-action' + (slot >= 0 ? ' active' : '')} aria-pressed={slot >= 0} onClick={save}>
          <PinIcon />
          {slot >= 0 ? `In slot ${hotbarSlotKey(slot)}` : empty >= 0 ? `Pin to ${hotbarSlotKey(empty)}` : 'Slots full'}
        </button>
        <button type="button" className="editor-action primary" onClick={() => setTool(id)}>
          {armed ? 'Armed' : 'Insert'}
        </button>
      </div>
    </div>
  );
}

function MarkConstructor() {
  const doc = useEditor((s) => s.document);
  const currentVoice = useEditor((s) => s.currentVoice);
  const [kind, setKind] = useState<MarkSpec['kind']>('dynamic');
  const [voices, setVoices] = useState<string[]>(doc.voices[currentVoice] ? [doc.voices[currentVoice].id] : []);
  const [dynamic, setDynamic] = useState<Dynamic>('mf');
  const [bpm, setBpm] = useState(100);
  const [withWord, setWithWord] = useState(false);
  const [beat, setBeat] = useState<RhythmicValue>({ value: 4, dots: 0 });
  const [clef, setClef] = useState<'treble' | 'bass'>('treble');
  const [octaves, setOctaves] = useState(1);
  const [clefOctave, setClefOctave] = useState(0);
  const [fifths, setFifths] = useState(0);
  const scoped = kind === 'dynamic' || kind === 'hairpin' || kind === 'slur';
  const spec: MarkSpec = kind === 'dynamic' ? { kind, dynamic, voiceIds: voices }
    : kind === 'hairpin' ? { kind, target: dynamic, voiceIds: voices }
    : kind === 'slur' ? { kind, voiceIds: voices }
    : kind === 'sustain' ? { kind }
    : kind === 'tempoBpm' ? { kind, bpm, beat, showLabel: withWord }
    : kind === 'transition' ? { kind, slower: true, targetBpm: bpm }
    : kind === 'clef' ? { kind, clef, octaveTransposition: clefOctave }
    : kind === 'key' ? { kind, fifths, alterations: alterationsOfFifths(fifths) }
    : { kind: 'octave', octaves };
  const id = markToolId(spec);
  const valid = (!scoped || voices.length > 0) && (kind !== 'octave' || octaves !== 0);
  const setTool = useEditor((s) => s.setTool);
  const slots = useEditor((s) => s.hotbarSlots);
  const setSlot = useEditor((s) => s.setHotbarSlot);
  const empty = slots.indexOf(null);
  return <>
    <div className="hp-scroll">
    <label className="editor-field-label">Mark<select value={kind} onChange={(e) => { setKind(e.target.value as MarkSpec['kind']); }}>
      {([['dynamic','Dynamic'],['hairpin','Hairpin'],['slur','Slur'],['sustain','Sustain pedal'],['tempoBpm','Tempo number'],['transition','Tempo transition'],['clef','Clef'],['key','Key signature'],['octave','Octave line']] as const)
        .map(([value,label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    {scoped && <VoicesField doc={doc} value={voices} onChange={setVoices} />}
    {(kind === 'dynamic' || kind === 'hairpin') && <ChoiceGroup ariaLabel="Target dynamic" variant="wrap" value={dynamic} options={DYNAMICS.map((v) => ({ value: v, label: v }))} onChange={setDynamic} />}
    {(kind === 'tempoBpm' || kind === 'transition') && <IntegerField label={kind === 'transition' ? 'Target BPM' : 'BPM'} value={bpm} min={1} onCommit={setBpm} />}
    {kind === 'tempoBpm' && <><RhythmField label="Tempo beat" value={beat} onChange={setBeat} /><label><input type="checkbox" checked={withWord} onChange={(e) => setWithWord(e.target.checked)} /> Show tempo name</label></>}

    {kind === 'clef' && <><ChoiceGroup ariaLabel="Clef" value={clef} options={[{ value: 'treble', label: 'Treble' },{ value: 'bass', label: 'Bass' }]} onChange={setClef} />
      <ChoiceGroup ariaLabel="Clef octave" value={String(clefOctave)} options={[{ value: "-1", label: "8vb" }, { value: "0", label: "Normal" }, { value: "1", label: "8va" }]} onChange={(value) => setClefOctave(Number(value))} /></>}
    {kind === 'octave' && <ChoiceGroup ariaLabel="Octaves" value={String(octaves)} options={[{ value: "-2", label: "15mb" }, { value: "-1", label: "8vb" }, { value: "1", label: "8va" }, { value: "2", label: "15ma" }]} onChange={(value) => setOctaves(Number(value))} />}
    {kind === 'key' && <KeySignatureChoices value={fifths} onChange={setFifths} />}
    <div className="hp-preview" draggable={valid} onDragStart={(e) => beginToolDrag(e, id)} onDragEnd={endToolDrag}><ToolIcon id={id} /></div>
    <p className="hp-note">{isSpanMark(spec) ? 'Click the start, then the end on the score.' : 'Click a position on the score.'}</p>
    </div>
    <div className="hp-footer hp-actions"><button type="button" className="editor-action" disabled={!valid || empty < 0} onClick={() => setSlot(empty, id)}><PinIcon />{empty >= 0 ? `Pin to ${hotbarSlotKey(empty)}` : 'Slots full'}</button>
      <button type="button" className="editor-action primary" disabled={!valid} onClick={() => setTool(id)}>Insert</button></div>
  </>;
}

