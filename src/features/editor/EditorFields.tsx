import { useState } from 'react';
import type { RhythmicValue, ScoreDocument } from '@/core/model/score';
import { ChoiceGroup } from '@/ui/ChoiceGroup';
import { MultiChoice } from '@/ui/MultiChoice';
import { useEditor } from '@/app/store';

export const maximumDots = (value: number) => Math.max(0, Math.floor(Math.log2(32 / value)));

export function IntegerField({ label, value, min, max, onCommit }: {
  label: string; value: number; min?: number; max?: number; onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [seen, setSeen] = useState(value);
  if (seen !== value) { setSeen(value); setDraft(String(value)); }
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() && Number.isSafeInteger(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) {
      if (n !== value) onCommit(n);
    } else setDraft(String(value));
  };
  return <label className="props-number"><span>{label}</span><input type="number" step="1" value={draft} min={min} max={max}
    onChange={(e) => setDraft(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') e.currentTarget.blur(); }} /></label>;
}

export function RhythmField({ label, value, onChange }: {
  label: string; value: RhythmicValue; onChange: (value: RhythmicValue) => void;
}) {
  return <fieldset className="editor-fields"><legend>{label}</legend>
    <ChoiceGroup ariaLabel={`${label} value`} value={String(value.value)}
      options={[1, 2, 4, 8, 16, 32].map((n) => ({ value: String(n), label: `1/${n}` }))}
      onChange={(v) => onChange({ value: Number(v), dots: Math.min(value.dots, maximumDots(Number(v))) })} />
    <IntegerField label={`${label} dots`} value={value.dots} min={0} max={maximumDots(value.value)}
      onCommit={(dots) => onChange({ ...value, dots })} />
  </fieldset>;
}

export function VoicesField({ doc, value, onChange }: {
  doc: ScoreDocument; value: string[]; onChange: (ids: string[]) => void;
}) {
  return <fieldset className="editor-fields"><legend>Voices</legend>
    <MultiChoice ariaLabel="Voices" value={value} options={doc.voices.map(voice => ({ value: voice.id, label: `Voice ${voice.index + 1}` }))} onChange={onChange} />
  </fieldset>;
}


/** The inspectors' one line about the policy (it is set in the strip above the sheet): how this edit
 *  treats the notes, and a link that opens the strip's menu. */
export function PitchPolicyField({ what }: { what: string }) {
  const policy = useEditor((s) => s.pitchPolicy);
  const open = useEditor((s) => s.setPolicyMenuOpen);
  const how = policy === 'ask' ? 'you choose each time' : policy === 'preserve_pitch' ? 'the sound is kept' : 'the position is kept';
  return <p className="props-note">{what}: {how}. <button type="button" className="props-note-link" onClick={() => open(true)}>Change</button></p>;
}
