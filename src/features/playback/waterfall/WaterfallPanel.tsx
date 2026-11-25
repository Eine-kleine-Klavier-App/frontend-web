import { useId, useMemo, useState, type CSSProperties } from 'react';
import { useEditor } from '@/app/store';
import { DEFAULT_VOICE_COLORS, resolveVoiceColor } from '@/core/model/voiceColors';
import { ChoiceThumb } from '@/ui/ChoiceGroup';
import { VoiceColorEditor } from '@/ui/VoiceColorEditor';
import { VoicePicker } from '@/ui/VoicePicker';
import { voiceRamp, rgba } from './waterfallPalette';
import { ListeningControls } from '../ListeningControls';
import { WATERFALL_SKIES, type WaterfallSky } from './WaterfallStage';

/** The colour of each voice: which voice, then how it looks in the waterfall (its ramp and how many notes it has), then the colour itself as in the Score. */
export function VoiceColourSection({ label = true }: { label?: boolean }) {
  const measures = useEditor((s) => s.document.measures);
  const voices = useEditor((s) => s.document.voices);
  const voiceColors = useEditor((s) => s.voiceColors);
  const setVoiceColor = useEditor((s) => s.setVoiceColor);
  const [voiceId, setVoiceId] = useState<string | null>(null);
  const noteCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const measure of measures) {
      for (const voice of measure.voices) {
        counts.set(voice.id, (counts.get(voice.id) ?? 0) + voice.items.reduce((sum, item) => sum + item.notes.length, 0));
      }
    }
    return counts;
  }, [measures]);
  const active = voices.find((voice) => voice.id === voiceId) ?? voices[0];
  if (!active) return null;
  const color = resolveVoiceColor(active.id, active.index, voiceColors);
  const ramp = voiceRamp(color);
  const count = noteCounts.get(active.id) ?? 0;
  return (
    <section className="waterfall-section" aria-label="Voice colour">
      {label && <span className="rail-label">Voice colour</span>}
      {voices.length > 1 && (
        <VoicePicker
          voices={voices.map((voice) => ({ id: voice.id, number: voice.index + 1, color: resolveVoiceColor(voice.id, voice.index, voiceColors), label: `Voice ${voice.index + 1}` }))}
          value={active.id}
          onChange={setVoiceId}
        />
      )}
      <div className="waterfall-voice" role="group" aria-label={`Voice ${active.index + 1} colour`}>
        <div className="waterfall-voice-head">
          <span>Voice {active.index + 1}</span>
          <small>{count} {count === 1 ? 'note' : 'notes'}</small>
        </div>
        <div className="voice-ramp" style={{ '--near': rgba(ramp.near), '--far': rgba(ramp.far) } as CSSProperties} aria-hidden="true" />
        <VoiceColorEditor voiceId={active.id} voiceNumber={active.index + 1} color={color} onChange={(next) => setVoiceColor(active.id, next)} />
      </div>
    </section>
  );
}

/** Session controls for the falling notes, keyboard light, voice colours and sky. */
export function WaterfallPanel({
  listening = false,
  voices = true,
  sky,
  onSky,
  stripColor,
  onStripColor,
  octaveLines,
  onOctaveLines,
  measureLines,
  onMeasureLines,
  backgroundDust,
  onBackgroundDust,
}: {
  listening?: boolean;
  /** the colours of the voices are a part of this panel; practice shows them as a group of their own */
  voices?: boolean;
  sky: WaterfallSky;
  onSky: (sky: WaterfallSky) => void;
  stripColor: string;
  onStripColor: (color: string) => void;
  octaveLines: boolean;
  onOctaveLines: (visible: boolean) => void;
  measureLines: boolean;
  onMeasureLines: (visible: boolean) => void;
  backgroundDust: boolean;
  onBackgroundDust: (visible: boolean) => void;
}) {
  const skyGroup = useId();
  return (
    <div className="waterfall-panel">
      {listening && <ListeningControls />}
      <section className="waterfall-section" aria-label="Guides">
        <span className="rail-label">Guides</span>
        <label className="waterfall-guide"><span>Octave lines</span><input type="checkbox" checked={octaveLines} onChange={(event) => onOctaveLines(event.target.checked)} /></label>
        <label className="waterfall-guide"><span>Measure lines</span><input type="checkbox" checked={measureLines} onChange={(event) => onMeasureLines(event.target.checked)} /></label>
      </section>
      <section className="waterfall-section" aria-label="Pedal light">
        <span className="rail-label">Pedal light</span>
        <label className="waterfall-strip-color">
          <span>Base colour</span>
          <input type="color" value={stripColor} aria-label="Pedal light base colour" onChange={(event) => onStripColor(event.target.value)} />
        </label>
      </section>
      {voices && <VoiceColourSection />}
      <section className="waterfall-section" aria-label="Sky">
        <span className="rail-label">Sky</span>
        <div className="sky-row keycap-grid" role="radiogroup" aria-label="Sky">
          {WATERFALL_SKIES.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={sky === option.value}
              className="sky-option"
              onClick={() => onSky(option.value)}
            >
              <span className="sky-swatch" style={{ '--sky': `var(--waterfall-sky-${option.value})` } as CSSProperties}>
                {sky === option.value && <ChoiceThumb groupId={skyGroup} />}
              </span>
              <span>{option.label}</span>
            </button>
          ))}
        </div>
        <label className="waterfall-guide"><span>Background dust</span><input type="checkbox" checked={backgroundDust} onChange={(event) => onBackgroundDust(event.target.checked)} /></label>
      </section>
    </div>
  );
}
