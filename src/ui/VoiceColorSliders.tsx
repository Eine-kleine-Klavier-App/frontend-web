import { useState } from 'react';
import { hexToHsv, hsvToHex, type HsvColor } from '@/core/model/voiceColors';
import { RangeField } from './RangeField';

const CHANNELS = [
  { channel: 'hue', label: 'Hue', max: 359, unit: '°' },
  { channel: 'saturation', label: 'Saturation', max: 100, unit: '%' },
  { channel: 'value', label: 'Value', max: 100, unit: '%' },
] as const;

interface ColorEdit {
  hex: string;
  hsv: HsvColor;
}

export function VoiceColorSliders({ value, onChange }: {
  value: string;
  onChange: (color: string) => void;
}) {
  const [lastEdit, setLastEdit] = useState<ColorEdit | null>(null);
  // HEX cannot encode the chosen hue at zero saturation or the saturation at zero value.
  const hsv = lastEdit?.hex === value ? lastEdit.hsv : hexToHsv(value);

  const change = (channel: keyof HsvColor, amount: number) => {
    const next = { ...hsv, [channel]: amount };
    const hex = hsvToHex(next);
    setLastEdit({ hex, hsv: next });
    if (hex !== value) onChange(hex);
  };

  return (
    <div className="voice-color-sliders">
      {CHANNELS.map(({ channel, label, max, unit }) => {
        const amount = Math.min(max, Math.round(hsv[channel]));
        return (
          <div key={channel}>
            <RangeField
              label={label}
              output={amount + unit}
              aria-valuetext={amount + unit}
              min={0}
              max={max}
              step={1}
              value={amount}
              onChange={(event) => change(channel, event.currentTarget.valueAsNumber)}
            />
          </div>
        );
      })}
    </div>
  );
}
