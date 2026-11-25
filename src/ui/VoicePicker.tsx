import type { CSSProperties } from 'react';

/** Which voice is being set: one round tile of its own colour per voice, the chosen one ringed. A voice is its colour, so the choice is
 *  visual; the number inside is for those who cannot tell the colours apart. */
export function VoicePicker({ voices, value, onChange }: {
  voices: { id: string; number: number; color: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="voice-picker" role="radiogroup" aria-label="Voice to colour">
      {voices.map((voice) => (
        <button
          key={voice.id}
          type="button"
          role="radio"
          aria-checked={voice.id === value}
          aria-label={voice.label}
          title={voice.label}
          className="voice-dot"
          style={{ '--vc': voice.color } as CSSProperties}
          onClick={() => onChange(voice.id)}
        >
          {voice.number}
        </button>
      ))}
    </div>
  );
}
