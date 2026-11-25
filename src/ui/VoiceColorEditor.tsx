import { useId, type CSSProperties } from 'react';
import { DEFAULT_VOICE_COLORS } from '@/core/model/voiceColors';
import { ChoiceThumb } from './ChoiceGroup';
import { VoiceColorField } from './VoiceColorField';
import { VoiceColorSliders } from './VoiceColorSliders';

/** The colour of one voice: the swatches, the code and the hue, saturation and value sliders. The one editor for the voice row over the sheet and the Waterfall panel;
 *  a colour that is not a voice's passes `label` instead of a voice number. */
export function VoiceColorEditor({ voiceId, voiceNumber, label, color, onChange }: {
  voiceId: string;
  voiceNumber?: number;
  label?: string;
  color: string;
  onChange: (color: string) => void;
}) {
  const group = useId();
  const name = label ?? `Voice ${voiceNumber}`;
  return (
    <>
      <div className="voice-swatch-row keycap-grid">
        {DEFAULT_VOICE_COLORS.map((swatch) => (
          <button
            key={swatch}
            type="button"
            className="voice-swatch"
            style={{ '--vc': swatch } as CSSProperties}
            title={swatch}
            aria-label={`${name} colour ${swatch}`}
            aria-pressed={swatch === color}
            onClick={() => onChange(swatch)}
          >
            {swatch === color && <ChoiceThumb groupId={group} />}
          </button>
        ))}
      </div>
      <VoiceColorField value={color} label={name} onChange={onChange} />
      <VoiceColorSliders key={voiceId} value={color} onChange={onChange} />
    </>
  );
}
