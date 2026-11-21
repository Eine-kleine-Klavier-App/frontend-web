import { useId, useMemo, type CSSProperties } from 'react';
import { useEditor } from '@/app/store';
import { DEFAULT_VOICE_COLORS, resolveVoiceColor } from '@/core/model/voiceColors';
import { ChoiceGroup, ChoiceThumb } from '@/ui/ChoiceGroup';
import { RangeField } from '@/ui/RangeField';
import { VoiceColorField } from '@/ui/VoiceColorField';
import { voiceRamp, rgba } from './waterfallPalette';
import { ListeningControls } from '../ListeningControls';
import { WATERFALL_SKIES, type WaterfallSky } from './WaterfallStage';

const TILT_OPTIONS = [
  { value: '-1', label: 'Sides', ariaLabel: 'From sides', title: 'From sides' },
  { value: '0', label: 'Vertical' },
  { value: '1', label: 'Centre', ariaLabel: 'From centre', title: 'From centre' },
];

/** Session controls for the falling notes, keyboard light, voice colours and sky. */
export function WaterfallPanel({
  listening = false,
  sky,
  onSky,
  stripColor,
  onStripColor,
  tilt,
  onTilt,
  octaveLines,
  onOctaveLines,
  measureLines,
  onMeasureLines,
  backgroundDust,
  onBackgroundDust,
}: {
  listening?: boolean;
  sky: WaterfallSky;
  onSky: (sky: WaterfallSky) => void;
  stripColor: string;
  onStripColor: (color: string) => void;
  tilt: number;
  onTilt: (tilt: number) => void;
  octaveLines: boolean;
  onOctaveLines: (visible: boolean) => void;
  measureLines: boolean;
  onMeasureLines: (visible: boolean) => void;
  backgroundDust: boolean;
  onBackgroundDust: (visible: boolean) => void;
}) {
  const measures = useEditor((s) => s.document.measures);
  const voices = useEditor((s) => s.document.voices);
  const voiceColors = useEditor((s) => s.voiceColors);
  const setVoiceColor = useEditor((s) => s.setVoiceColor);
  const tiltPercent = Math.round(tilt * 100);
  const tiltText = tilt === 0 ? 'Vertical' : `${Math.abs(tiltPercent)}% from ${tilt < 0 ? 'sides' : 'centre'}`;
  const swatchGroup = useId();
  const skyGroup = useId();
  const noteCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const measure of measures) {
      for (const voice of measure.voices) {
        counts.set(voice.id, (counts.get(voice.id) ?? 0) + voice.items.reduce((sum, item) => sum + item.notes.length, 0));
      }
    }
    return counts;
  }, [measures]);
  return (
    <div className="waterfall-panel">
      {listening && <ListeningControls />}
      <section className="waterfall-section" aria-label="Guides">
        <span className="rail-label">Guides</span>
        <label className="waterfall-guide"><span>Octave lines</span><input type="checkbox" checked={octaveLines} onChange={(event) => onOctaveLines(event.target.checked)} /></label>
        <label className="waterfall-guide"><span>Measure lines</span><input type="checkbox" checked={measureLines} onChange={(event) => onMeasureLines(event.target.checked)} /></label>
      </section>
      <section className="waterfall-section waterfall-tilt" aria-label="Note tilt">
        <span className="rail-label">Note tilt</span>
        <ChoiceGroup value={TILT_OPTIONS.some((option) => Number(option.value) === tilt) ? String(tilt) : null} onChange={(value) => onTilt(Number(value))} options={TILT_OPTIONS} ariaLabel="Note tilt presets" />
        <RangeField
          label="Manual tilt"
          output={`${tiltPercent > 0 ? '+' : ''}${tiltPercent}%`}
          min={-100}
          max={100}
          step={1}
          value={tiltPercent}
          aria-valuetext={tiltText}
          onChange={(event) => onTilt(Number(event.target.value) / 100)}
        />
      </section>
      <section className="waterfall-section" aria-label="Pedal light">
        <span className="rail-label">Pedal light</span>
        <label className="waterfall-strip-color">
          <span>Base colour</span>
          <input type="color" value={stripColor} aria-label="Pedal light base colour" onChange={(event) => onStripColor(event.target.value)} />
        </label>
      </section>
      <section className="waterfall-section" aria-label="Voices">
        <span className="rail-label">Voices</span>
        {voices.map((voice) => {
          const chosen = resolveVoiceColor(voice.id, voice.index, voiceColors);
          const ramp = voiceRamp(chosen);
          const count = noteCounts.get(voice.id) ?? 0;
          return (
            <div key={voice.id} className="waterfall-voice" role="group" aria-label={`Voice ${voice.index + 1} colour`}>
              <div className="waterfall-voice-head">
                <span>Voice {voice.index + 1}</span>
                <small>{count} {count === 1 ? 'note' : 'notes'}</small>
              </div>
              <div className="voice-ramp" style={{ '--near': rgba(ramp.near), '--far': rgba(ramp.far) } as CSSProperties} aria-hidden="true" />
              <div className="voice-swatch-row keycap-grid">
                {DEFAULT_VOICE_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className="voice-swatch"
                    style={{ '--vc': color } as CSSProperties}
                    title={color}
                    aria-label={`Voice ${voice.index + 1} colour ${color}`}
                    aria-pressed={color === chosen}
                    onClick={() => setVoiceColor(voice.id, color)}
                  >
                    {color === chosen && <ChoiceThumb groupId={`${swatchGroup}-${voice.id}`} />}
                  </button>
                ))}
              </div>
              <VoiceColorField value={chosen} label={`Voice ${voice.index + 1}`} onChange={(color) => setVoiceColor(voice.id, color)} />
            </div>
          );
        })}
      </section>
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
