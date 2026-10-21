import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/app/store';
import { ContextIndex, toBeats } from '@/core/model/contexts';
import { staffStepToKey } from '@/core/model/pitch';
import type { ClefName, PitchMode, ScoreDocument } from '@/core/model/score';
import type { Command } from '@/core/commands/command';
import { renderStaffExampleSvg } from '@/rendering/vexflow/noteGlyph';

const SAMPLE = 4;

const clefTitle = (clef: ClefName) => (clef === 'treble' ? 'Treble' : 'Bass');
const keyName = (key: string) => { const [letter, octave] = key.split('/'); return `${letter.toUpperCase()}${octave}`; };

/** What a clef change does to the notes it governs, read off the document: how many there are, the bars
 *  they span, and the first few drawn both ways — kept by sound (the same pitch names, other places on
 *  the staff) and kept by place (the same places, other pitch names). */
function clefChangeExample(doc: ScoreDocument, command: Extract<Command, { type: 'setClef' }>) {
  const index = new ContextIndex(doc);
  const start = index.order(command.measureId, toBeats(command.position));
  const next = doc.contexts
    .filter((c) => c.kind === 'clef' && c.staffId === command.staffId && index.order(c.measureId, toBeats(c.position)) > start)
    .map((c) => index.order(c.measureId, toBeats(c.position)))
    .sort((a, b) => a - b)[0] ?? Infinity;
  const oldClef: ClefName = index.clefNameAt(command.staffId, command.measureId, toBeats(command.position));
  const governed: { order: number; step: number; bar: number }[] = [];
  doc.measures.forEach((measure, bar) => {
    for (const voice of measure.voices) for (const item of voice.items) {
      if (item.kind !== 'note') continue;
      const order = index.order(measure.id, item.position);
      if (order < start || order >= next) continue;
      for (const note of item.notes) if (note.staffId === command.staffId) governed.push({ order, step: note.staffStep, bar });
    }
  });
  governed.sort((a, b) => a.order - b.order || a.step - b.step);
  const shown = governed.slice(0, SAMPLE);
  const soundKeys = shown.map((n) => staffStepToKey(n.step, oldClef));
  const soundSteps = soundKeys.map((key) => {
    for (let step = -14; step <= 30; step += 1) if (staffStepToKey(step, command.clef) === key) return step;
    return 0;
  });
  const placeSteps = shown.map((n) => n.step);
  return {
    oldClef,
    count: governed.length,
    firstBar: governed[0] ? governed[0].bar + 1 : 0,
    lastBar: governed.length ? governed[governed.length - 1].bar + 1 : 0,
    sound: { steps: soundSteps, names: soundKeys.map(keyName) },
    place: { steps: placeSteps, names: placeSteps.map((step) => keyName(staffStepToKey(step, command.clef))) },
  };
}

/** a few notes engraved on a short staff, the same VexFlow the score uses */
function MiniStaff({ clef, steps }: { clef: ClefName; steps: number[] }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (host) renderStaffExampleSvg(clef, steps, host);
  }, [clef, steps.join(',')]);
  return <div className="pm-mini" ref={hostRef} />;
}

/** The question an edit asks when the policy is "Ask first": keep the sound or keep the place. Opens
 *  under the strip's policy chip (ContextStrip wraps it). S and P answer, a click outside cancels. */
export function PitchModePrompt() {
  const request = useEditor((s) => s.pitchModeRequest);
  const doc = useEditor((s) => s.document);
  const resolve = useEditor((s) => s.resolvePitchMode);
  const setPolicy = useEditor((s) => s.setPitchPolicy);
  const [remember, setRemember] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // the card stays up while it lifts away, after the request is gone
  const lastCommand = useRef<Command | null>(null);
  if (request) lastCommand.current = request.command;
  const command = lastCommand.current;

  const choose = (mode: PitchMode) => { if (remember) setPolicy(mode); resolve(mode); };

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    rootRef.current?.querySelector<HTMLButtonElement>('.pm-card')?.focus();
    return () => { if (before && before.isConnected) before.focus(); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const answer = e.code === 'KeyS' ? 'preserve_pitch' : e.code === 'KeyP' ? 'preserve_step' : undefined;
      if (answer !== undefined) {
        e.preventDefault();
        e.stopImmediatePropagation();
        choose(answer);
      } else if (e.key === 'Tab') {
        const stops = Array.from(rootRef.current?.querySelectorAll<HTMLElement>('button, input') ?? []);
        if (!stops.length) return;
        const at = stops.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target as Element).closest('.strip-policy')) resolve(null);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  });

  const example = command?.type === 'setClef' ? clefChangeExample(doc, command) : null;
  const title = command?.type === 'setClef' && example
    ? `Change ${clefTitle(example.oldClef)} clef to ${clefTitle(command.clef)} clef?`
    : command?.type === 'deleteClef' ? 'Remove this clef?' : 'How should the notes change?';
  const clef = command?.type === 'setClef' ? command.clef : 'treble';

  return (
    <div className="pm" ref={rootRef}>
      <h2 className="pm-title">{title}</h2>
      <p className="pm-sub">
        {example && example.count
          ? `This staff has ${example.count} ${example.count === 1 ? 'note' : 'notes'} in ${example.firstBar === example.lastBar ? `bar ${example.firstBar}` : `bars ${example.firstBar} to ${example.lastBar}`} (first shown: ${example.sound.names.join(' ')}). Choose what happens to them.`
          : 'Choose how this edit affects the notes.'}
      </p>
      <div className="pm-cards">
        <button type="button" className="pm-card pm-card--default" onClick={() => choose('preserve_pitch')}>
          <span className="pm-card-title">Keep sound <kbd>S</kbd></span>
          {example && <MiniStaff clef={clef} steps={example.sound.steps} />}
          {example && <span className="pm-names">{example.sound.names.join(' ')}</span>}
          <span className="pm-caption">Same pitches, redrawn on the new staff.</span>
        </button>
        <button type="button" className="pm-card" onClick={() => choose('preserve_step')}>
          <span className="pm-card-title">Keep position <kbd>P</kbd></span>
          {example && <MiniStaff clef={clef} steps={example.place.steps} />}
          {example && <span className="pm-names">{example.place.names.join(' ')}</span>}
          <span className="pm-caption">Same place on the staff, the pitches change.</span>
        </button>
      </div>
      <div className="pm-foot">
        <label><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Don't ask again</label>
        <span>Change it later in “Staff changes”.</span>
        <button type="button" className="pm-cancel" onClick={() => resolve(null)}>Cancel</button>
      </div>
    </div>
  );
}
