import { useId, useState, type ReactNode } from 'react';
import { useMidiState, type MidiState } from '@/core/midi/MidiInput';
import { RangeField } from '@/ui/RangeField';
import { AlertIcon, ChevronRightIcon, GalleryHorizontalIcon, PaletteIcon, PlugZapIcon, PracticeIcon, UnplugIcon } from '@/ui/icons';
import { VoiceColorEditor } from '@/ui/VoiceColorEditor';
import { VoiceColourSection } from '@/features/playback/waterfall/WaterfallPanel';

type RailGroup = 'practice' | 'voices' | 'mistakes' | 'strip';

export interface StripSettings {
  /** where the line stands, as a share of the strip's width */
  lineAt: number;
  /** the clef, key and time signature stay at the left once the notes have moved on */
  pinHead: boolean;
}

/** What the keyboard is doing, in words the player can act on. */
export function keyboardNote(midi: MidiState): { text: string; hint: string | null; ok: boolean } {
  switch (midi.status) {
    case 'unsupported':
      return { text: 'This browser cannot read a MIDI keyboard.', hint: 'Use Chrome or Edge.', ok: false };
    case 'denied':
      return { text: 'MIDI access is blocked.', hint: 'Allow MIDI for this site, then reload.', ok: false };
    case 'searching':
      return { text: 'No MIDI devices in the list.', hint: 'Switch the keyboard on and pair it with this computer.', ok: false };
    case 'waiting':
      return { text: 'Press any key.', hint: null, ok: false };
    case 'lost':
      return { text: `${midi.active?.name ?? 'The keyboard'} is not connected.`, hint: 'Switch it on or reconnect it.', ok: false };
    default:
      return { text: `${midi.active?.name ?? 'Keyboard'} connected.`, hint: null, ok: true };
  }
}

/** One group of settings: its icon, name and, while it is closed, what it is set to. Opening one closes the others. */
function Group({ name, icon, summary, open, onToggle, children }: {
  name: string;
  icon: ReactNode;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="rail-group" data-open={open}>
      <button type="button" className="rail-group-head" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span className="rail-group-icon">{icon}</span>
        <span className="rail-group-text">
          <span className="rail-label">{name}</span>
          <span className="rail-group-summary"><span>{summary}</span></span>
        </span>
        <span className="rail-group-chevron"><ChevronRightIcon /></span>
      </button>
      <div id={id} className="rail-group-body" role="region" aria-label={name}>
        <div className="rail-group-inner"><div className="rail-group-content">{children}</div></div>
      </div>
    </section>
  );
}

function PracticeGroup() {
  const midi = useMidiState();
  const note = keyboardNote(midi);
  return (
    <>
      <div className="rail-keyboard" role="status" data-ok={note.ok}>
        {note.ok ? <PlugZapIcon /> : <UnplugIcon />}
        <span>{note.text}</span>
      </div>
      {note.hint && <p className="practice-hint">{note.hint}</p>}
    </>
  );
}

/** What the left panel holds under its toolbar: groups of settings, one open at a time. The strip's groups are there only while the strip of notes is on screen, which they set:
 *  where its line stands and the colours of the voices its notes are drawn in. The colour of a wrong key is set for the keyboard, which is always there. Parts of the editor's own panels are reused. */
export function PracticeRailBody({ strip, onStrip, stripShown, mistakeColour, onMistakeColour }: {
  strip: StripSettings;
  onStrip: (patch: Partial<StripSettings>) => void;
  stripShown: boolean;
  mistakeColour: string;
  onMistakeColour: (colour: string) => void;
}) {
  const [chosen, setChosen] = useState<RailGroup | null>('practice');
  const present: Record<RailGroup, boolean> = { practice: true, voices: stripShown, mistakes: true, strip: stripShown };
  // a group that has gone from the panel is not the open one
  const open = chosen && present[chosen] ? chosen : null;
  const midi = useMidiState();
  const toggle = (group: RailGroup) => setChosen((current) => (current === group ? null : group));
  const device = midi.status === 'connected' ? midi.active?.name ?? 'Keyboard' : 'No keyboard';
  return (
    <div className="rail-accordion">
      <Group name="Practice" icon={<PracticeIcon />} summary={device} open={open === 'practice'} onToggle={() => toggle('practice')}>
        <PracticeGroup />
      </Group>
      {present.voices && <Group name="Voice colour" icon={<PaletteIcon />} summary="Colour of each voice" open={open === 'voices'} onToggle={() => toggle('voices')}>
        <VoiceColourSection label={false} />
      </Group>}
      <Group name="Mistakes" icon={<AlertIcon />} summary="Colour of a wrong key" open={open === 'mistakes'} onToggle={() => toggle('mistakes')}>
        <section className="waterfall-section" aria-label="Mistake colour">
          <div className="waterfall-voice" role="group" aria-label="Mistake colour">
            <VoiceColorEditor voiceId="mistake" label="Mistake" color={mistakeColour} onChange={onMistakeColour} />
          </div>
        </section>
      </Group>
      {present.strip && <Group name="Strip of notes" icon={<GalleryHorizontalIcon />} summary={`Line at ${Math.round(strip.lineAt * 100)}%`} open={open === 'strip'} onToggle={() => toggle('strip')}>
        <RangeField
          label="Line position"
          output={`${Math.round(strip.lineAt * 100)}%`}
          min={5}
          max={45}
          step={1}
          value={Math.round(strip.lineAt * 100)}
          onChange={(event) => onStrip({ lineAt: Number(event.target.value) / 100 })}
        />
        <label className="waterfall-guide"><span>Clef, key and time stay at the left</span><input type="checkbox" checked={strip.pinHead} onChange={(event) => onStrip({ pinHead: event.target.checked })} /></label>
      </Group>}
    </div>
  );
}
