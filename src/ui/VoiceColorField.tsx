import { useState } from 'react';
import { parseHexColor } from '@/core/model/voiceColors';

/** The colour of a voice as a code that is always shown and always editable. A code typed is applied on Enter or on
 *  leaving the field; one that is not a colour is marked and, on leaving, gives way to the colour the voice has. One
 *  component for the voice row over the sheet and the Waterfall panel. */
export function VoiceColorField({ value, label, onChange }: { value: string; label: string; onChange: (color: string) => void }) {
  const [typed, setTyped] = useState<string | null>(null);
  const invalid = typed !== null && parseHexColor(typed) === null;
  const finish = () => {
    const parsed = typed === null ? null : parseHexColor(typed);
    if (parsed) onChange(parsed);
    setTyped(null);
  };

  return (
    <input
      type="text"
      className="voice-color-hex"
      value={typed ?? value.toUpperCase()}
      maxLength={7}
      spellCheck={false}
      autoComplete="off"
      aria-label={`${label} colour code`}
      aria-invalid={invalid}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setTyped(event.target.value)}
      onBlur={finish}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}
