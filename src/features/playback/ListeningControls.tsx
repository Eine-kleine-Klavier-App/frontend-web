import { useEffect, useId, useState } from 'react';
import { playback, usePlaybackValue } from '@/core/playback/PlaybackController';
import { DEFAULT_PLAYBACK_SETTINGS, type PlaybackSettings } from '@/core/playback/PlaybackSettings';
import { useEditor } from '@/app/store';
import { errorMessage } from '@/core/errorMessage';
import { Button } from '@/ui/Button';
import { RangeField } from '@/ui/RangeField';
import { KEY_RANGE } from './waterfall/waterfallProportions';

/** the keys that move a range input: releasing one ends the gesture */
const RANGE_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'];

/** Session listening controls commit once per gesture, leaving source notation intact. */
export function ListeningControls() {
  const source = useEditor((state) => state.source);
  const settings = usePlaybackValue((state) => state.listening);
  const ready = usePlaybackValue((state) => !!state.map && !state.mapLoading);
  const [draft, setDraft] = useState<PlaybackSettings>(settings);
  const [error, setError] = useState<string | null>(null);
  const hintId = useId();

  useEffect(() => {
    setDraft(settings);
    setError(null);
  }, [settings]);
  useEffect(() => {
    if (source?.kind === 'saved') void playback.prepareMap();
  }, [source]);

  const commit = (next = draft) => {
    try {
      playback.setListeningSettings(next, KEY_RANGE);
      setError(null);
    } catch (cause) {
      setDraft(settings);
      setError(errorMessage(cause, 'Playback settings could not be changed.'));
    }
  };
  const cancel = () => {
    setDraft(settings);
    setError(null);
  };
  // the gesture's end: what commits the drafted value
  const gesture = {
    disabled: !ready,
    onPointerUp: () => commit(),
    onPointerCancel: cancel,
    onKeyUp: (event: { key: string }) => {
      if (RANGE_KEYS.includes(event.key)) commit();
    },
    onBlur: () => commit(),
  };

  return (
    <section className="waterfall-section listening-controls" aria-label="Listening settings">
      <span className="rail-label">Playback</span>
      <div className="listening-field">
        <RangeField
          label="Speed"
          output={`${draft.speed.toFixed(2)}×`}
          min={0.5}
          max={2}
          step={0.05}
          value={draft.speed}
          aria-valuetext={`${draft.speed.toFixed(2)} times`}
          onChange={(event) => setDraft({ ...draft, speed: Number(event.target.value) })}
          {...gesture}
        />
      </div>
      <div className="listening-field">
        <RangeField
          label="Transpose"
          output={`${draft.transpose > 0 ? '+' : ''}${draft.transpose}`}
          min={-12}
          max={12}
          step={1}
          value={draft.transpose}
          aria-valuetext={`${draft.transpose > 0 ? 'plus ' : ''}${draft.transpose} semitones`}
          aria-describedby={hintId}
          onChange={(event) => setDraft({ ...draft, transpose: Number(event.target.value) })}
          {...gesture}
        />
      </div>
      <p id={hintId} className="listening-hint">Sound and waterfall only. The score stays in its original key.</p>
      {error && <p className="listening-error" role="alert">{error}</p>}
      <Button
        variant="ghost"
        disabled={!ready || (settings.speed === 1 && settings.transpose === 0)}
        onClick={() => commit({ ...DEFAULT_PLAYBACK_SETTINGS })}
      >
        Reset playback settings
      </Button>
    </section>
  );
}
