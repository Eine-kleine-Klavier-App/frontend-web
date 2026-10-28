import type { ReactNode } from 'react';
import { useEditor } from '@/app/store';
import { ContextIndex, keyOfAlterations } from '@/core/model/contexts';
import { ARTICULATION_LABEL } from '@/core/model/articulation';
import { ORNAMENT_SIGNS } from '@/core/model/ornament';
import { describeSelection } from '@/core/model/query';
import { passesLabel } from '@/core/model/repeats';
import type { Fraction, RefrainContext, ScoreContext, ScoreDocument, VoltaContext } from '@/core/model/score';
import { ObjectHeader } from './ContextInspector';
import { durationName, spelledPitch, staffName } from './PropertiesPanel';

// What is selected, told in plain rows: the reading view's counterpart of the editor's inspector. The same picks, the same names and
// values, and nothing to change: no controls, no removal. Shown in the rail when something is picked, in place of the playback settings.

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <div className="info-rows">
      {rows.map(([name, value]) => (
        <div className="info-row" key={name}>
          <span>{name}</span>
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
}

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

/** the bar a place falls in, counted from one; a place at the very start of a bar is that bar */
const barOf = (doc: ScoreDocument, measureId: string | null): string =>
  measureId === null ? 'End of score' : `Bar ${doc.measures.findIndex((measure) => measure.id === measureId) + 1}`;

/** the bars a stretch covers, "Bars 3–4": it ends before the bar it ends at the start of */
function barsOf(doc: ScoreDocument, startId: string, endId: string | null, endPosition: Fraction | null): string {
  const first = doc.measures.findIndex((measure) => measure.id === startId) + 1;
  const endIndex = endId === null ? doc.measures.length : doc.measures.findIndex((measure) => measure.id === endId) + (endPosition && endPosition.numerator > 0 ? 1 : 0);
  return endIndex <= first ? `Bar ${first}` : `Bars ${first}–${endIndex}`;
}

const voiceNames = (doc: ScoreDocument, ids: string[]): string =>
  ids.map((id) => `Voice ${(doc.voices.find((voice) => voice.id === id)?.index ?? 0) + 1}`).join(' · ');

const CONTEXT_NAME: Record<ScoreContext['kind'], string> = {
  clef: 'Clef', keySignature: 'Key signature', dynamic: 'Dynamic', tempo: 'Tempo', hairpin: 'Hairpin', slur: 'Slur', octave: 'Octave line',
  tempoTransition: 'Tempo change', sustain: 'Sustain pedal', refrain: 'Repeat', volta: 'Endings',
};

function contextRows(doc: ScoreDocument, context: ScoreContext): [string, ReactNode][] {
  const from: [string, ReactNode] = ['Starts', barOf(doc, context.measureId)];
  switch (context.kind) {
    case 'clef': return [['Clef', capital(context.clef)], ['Staff', staffName(doc.staffOrder, context.staffId)], ['Octave', context.octaveTransposition === 0 ? 'As written' : String(context.octaveTransposition)], from];
    case 'keySignature': return [['Key', keyOfAlterations(context.alterations).name], ['Staff', staffName(doc.staffOrder, context.staffId)], from];
    case 'dynamic': return [['Dynamic', context.dynamic], ['Voices', voiceNames(doc, context.voiceIds)], from];
    case 'tempo': return [['Beats per minute', context.bpm ?? 'None'], ['Word', context.label ? capital(context.label) : 'None'], from];
    case 'hairpin': return [['Kind', context.type === 'crescendo' ? 'Crescendo' : 'Diminuendo'], ['Voices', voiceNames(doc, context.voiceIds)], ['Covers', barsOf(doc, context.measureId, context.endMeasureId, context.endPosition)]];
    case 'slur': return [['Voices', voiceNames(doc, context.voiceIds)], ['Covers', barsOf(doc, context.measureId, context.endMeasureId, context.endPosition)]];
    case 'octave': return [['Line', ({ '1': '8va', '2': '15ma', '-1': '8vb', '-2': '15mb' } as Record<string, string>)[String(context.octaves)] ?? `${context.octaves} octaves`], ['Staff', staffName(doc.staffOrder, context.staffId)], ['Covers', barsOf(doc, context.measureId, context.endMeasureId, context.endPosition)]];
    case 'tempoTransition': return [['Kind', context.ratio && context.ratio.numerator < context.ratio.denominator ? 'Ritardando' : 'Accelerando'], ['Covers', barsOf(doc, context.measureId, context.endMeasureId, context.endPosition)]];
    case 'sustain': return [['Covers', barsOf(doc, context.measureId, context.endMeasureId, context.endPosition)]];
    case 'refrain': return [['Times played', context.times], ['Covers', barsOf(doc, context.measureId, context.endMeasureId, context.endPosition)]];
    case 'volta': return [
      ['Passes', context.passCount],
      ['Body', barsOf(doc, context.measureId, context.bodyEndMeasureId, context.bodyEndPosition)],
      ...context.fragments.map((fragment, index): [string, ReactNode] => [`Ending ${index + 1}`, `${passesLabel(fragment.passes)}`]),
    ];
  }
}

export function SelectionInfo() {
  const document = useEditor((s) => s.document);
  const selectedIds = useEditor((s) => s.selectedIds);
  const carrierSelectedIds = useEditor((s) => s.carrierSelectedIds);
  const selectedMeasureIds = useEditor((s) => s.selectedMeasureIds);
  const selectedStructureIds = useEditor((s) => s.selectedStructureIds);
  const stemOverrides = useEditor((s) => s.stemOverrides);

  const measures = document.measures.filter((measure) => selectedMeasureIds.includes(measure.id));
  const beams = document.beams.filter((beam) => selectedStructureIds.includes(beam.id));
  const tuplets = document.tuplets.filter((tuplet) => selectedStructureIds.includes(tuplet.id));
  const ties = document.ties.filter((tie) => selectedStructureIds.includes(tie.id));
  const glissandos = document.glissandos.filter((glissando) => selectedStructureIds.includes(glissando.id));
  const contexts = document.contexts.filter((context) => selectedStructureIds.includes(context.id));
  const structureCount = beams.length + tuplets.length + ties.length + glissandos.length;

  if (structureCount > 0 && selectedIds.length === 0 && measures.length === 0) {
    if (structureCount > 1) return <ObjectHeader title={`${structureCount} connections`} sub="Beams, tuplets, ties" />;
    if (beams[0]) return <><ObjectHeader title="Beam" /><Rows rows={[['Notes', beams[0].carrierIds.length]]} /></>;
    if (tuplets[0]) return <><ObjectHeader title="Tuplet" /><Rows rows={[['Ratio', `${tuplets[0].numNotes}:${tuplets[0].notesOccupied}`], ['Notes', tuplets[0].carrierIds.length]]} /></>;
    if (ties[0]) return <ObjectHeader title="Tie" sub="Joins two notes of one pitch" />;
    return <><ObjectHeader title="Glissando" /><Rows rows={[['Line', glissandos[0].glissandoType === 'wavy' ? 'Wavy' : 'Straight']]} /></>;
  }

  if (contexts.length > 0 && selectedIds.length === 0 && measures.length === 0) {
    if (contexts.length > 1) return <ObjectHeader title={`${contexts.length} marks`} />;
    return <><ObjectHeader title={CONTEXT_NAME[contexts[0].kind]} /><Rows rows={contextRows(document, contexts[0])} /></>;
  }

  if (measures.length > 0) {
    const signatures = new Set(measures.map((measure) => `${measure.timeSignature.beats}/${measure.timeSignature.beatValue}`));
    const counted = describeSelection(document, measures.flatMap((measure) => measure.voices.flatMap((voice) => voice.items.flatMap((item) => (item.kind === 'rest' ? [item.id] : item.notes.map((note) => note.noteId))))));
    const first = document.measures.indexOf(measures[0]) + 1;
    const last = document.measures.indexOf(measures[measures.length - 1]) + 1;
    const indexOf = (id: string | null) => (id === null ? document.measures.length : document.measures.findIndex((measure) => measure.id === id));
    const repeats = document.contexts.filter((context): context is RefrainContext | VoltaContext => {
      if (context.kind !== 'refrain' && context.kind !== 'volta') return false;
      const start = indexOf(context.measureId);
      const end = context.kind === 'refrain' ? indexOf(context.endMeasureId) : Math.max(indexOf(context.bodyEndMeasureId), ...context.fragments.map((fragment) => indexOf(fragment.endMeasureId)));
      return measures.some((measure) => document.measures.indexOf(measure) >= start && document.measures.indexOf(measure) < end);
    });
    return (
      <>
        <ObjectHeader title={measures.length === 1 ? 'Measure' : `Measures · ${measures.length}`} sub={measures.length === 1 ? `Bar ${first}` : `Bars ${first}–${last}`} />
        <Rows rows={[
          ['Time signature', signatures.size === 1 ? [...signatures][0] : 'Mixed'],
          ['Notes', counted.noteCount],
          ['Rests', counted.restCount],
          ...repeats.map((context): [string, ReactNode] => context.kind === 'refrain'
            ? ['Repeat', `${context.times} times · ${barsOf(document, context.measureId, context.endMeasureId, context.endPosition)}`]
            : ['Endings', `${context.passCount} passes · ${barsOf(document, context.measureId, context.bodyEndMeasureId, context.bodyEndPosition)}`]),
        ]} />
      </>
    );
  }

  if (selectedIds.length === 0) return null;

  const { carriers, noteCount, restCount } = describeSelection(document, selectedIds);
  const single = carriers.length === 1 ? carriers[0] : null;
  const isSingleNote = noteCount === 1 && restCount === 0 && carriers.length === 1;
  const isWholeChord = single != null && single.item.kind === 'note' && single.whole && single.item.notes.length > 1;
  const isSingleRest = restCount === 1 && noteCount === 0 && carriers.length === 1;
  const name = single ? durationName(single.item.duration, single.item.dots) : '';
  const grace = !!single?.item.grace;
  const clefAt = (staffId: string, measureId: string, position: number) => new ContextIndex(document).clefNameAt(staffId, measureId, position);
  const pitchOf = (note: NonNullable<typeof single>['item']['notes'][number], measureId: string, position: number) => spelledPitch(note.staffStep, clefAt(note.staffId, measureId, position), note.accidental);

  const title = isSingleRest ? `${name} rest` : isWholeChord ? `${name} ${grace ? 'grace chord' : 'chord'}` : isSingleNote ? `${name} ${grace ? 'grace note' : 'note'}` : `Selection · ${noteCount + restCount}`;

  if (!single) {
    const voices = [...new Set(carriers.map((carrier) => carrier.voiceId))];
    const durations = [...new Set(carriers.map((carrier) => durationName(carrier.item.duration, carrier.item.dots)))];
    return (
      <>
        <ObjectHeader title={title} sub={[noteCount > 0 ? `${noteCount} ${noteCount === 1 ? 'note' : 'notes'}` : '', restCount > 0 ? `${restCount} ${restCount === 1 ? 'rest' : 'rests'}` : ''].filter(Boolean).join(' · ')} />
        <Rows rows={[['Voices', voiceNames(document, voices)], ['Values', durations.join(' · ')]]} />
      </>
    );
  }

  const item = single.item;
  const barIndex = document.measures.findIndex((measure) => measure.id === single.measureId);
  const rows: [string, ReactNode][] = [];
  if (isSingleNote) {
    const note = single.notes[0];
    rows.push(['Pitch', pitchOf(note, single.measureId, item.position)], ['Staff', staffName(document.staffOrder, note.staffId)]);
  } else if (isWholeChord) {
    rows.push(['Notes', item.notes.map((note) => pitchOf(note, single.measureId, item.position)).join(' · ')]);
  }
  rows.push(['Voice', voiceNames(document, [single.voiceId])], ['Bar', barIndex + 1], ['Duration', name]);
  if (isSingleNote) {
    const note = single.notes[0];
    rows.push(['Fingering', note.fingering > 0 ? note.fingering : 'None']);
    const tied = document.ties.find((tie) => tie.startNoteId === note.noteId || tie.endNoteId === note.noteId);
    rows.push(['Tie', tied ? (tied.startNoteId === note.noteId ? 'Tied to the next note' : 'Tied from the previous note') : 'None']);
  }
  if (item.kind === 'note') {
    rows.push(['Articulation', item.articulations.length ? item.articulations.map((mark) => ARTICULATION_LABEL[mark]).join(' · ') : 'None']);
    rows.push(['Ornament', item.ornament && item.ornament !== 'none' ? ORNAMENT_SIGNS.find((sign) => sign.value === item.ornament)?.label ?? item.ornament : 'None']);
    if (!grace && item.duration !== 'w' && single.whole && (item.notes.length > 1 || carrierSelectedIds.includes(item.id))) {
      const direction = stemOverrides[item.id]?.direction ?? 0;
      rows.push(['Stem', direction === 1 ? 'Up' : direction === -1 ? 'Down' : 'Automatic']);
    }
  }
  if (grace && item.grace) rows.push(['Grace', item.grace.kind === 'acciaccatura' ? 'Slashed' : 'Plain']);

  return (
    <>
      <ObjectHeader
        title={title}
        sub={isSingleNote ? pitchOf(single.notes[0], single.measureId, item.position) : isWholeChord ? item.notes.map((note) => pitchOf(note, single.measureId, item.position)).join(' · ') : undefined}
      />
      <Rows rows={rows} />
    </>
  );
}
