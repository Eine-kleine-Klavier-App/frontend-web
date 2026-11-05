import { motion, type MotionValue } from 'motion/react';
import { PlayIcon, PauseIcon, StopIcon } from '@/ui/icons';
import { playback, usePlayback } from '@/core/playback/PlaybackController';
import { useEditor } from '@/app/store';
import { barAtBeat } from '@/core/model/query';

/** The transport: a pill centred over the content column. Play is the one accent fill on the page. `shift` carries it along while the column's edge moves (the panel opening). */
export function PlaybackBar({ shift }: { shift?: MotionValue<number> }) {
  const { playing, loading, paused, ready, timeBeats, seekBeats, totalBeats } = usePlayback();
  const documentLoading = useEditor((s) => s.loading);
  const doc = useEditor((s) => s.document);
  // The chosen start position; audio elapsed time is not a musical-time map.
  const position = barAtBeat(doc, timeBeats);
  const bar = position.index + 1;
  const beat = position.beat;
  return (
    <motion.div className="transport" style={{ x: shift }} role="group" aria-label="Playback" aria-busy={loading}>
      <button
        type="button"
        className="play"
        aria-label={loading ? 'Cancel loading audio' : playing ? 'Pause playback' : paused ? 'Resume playback' : 'Play from line'}
        disabled={!ready || documentLoading}
        title={loading ? 'Loading audio…' : playing ? 'Pause playback' : 'Play from the start line'}
        onClick={() => { if (loading) playback.stop(); else if (playing) playback.pause(); else void playback.play(); }}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <button type="button" className="icon-btn ghost" title="Stop" aria-label="Stop playback" disabled={!ready} onClick={() => playback.stop()}>
        <StopIcon />
      </button>
      <span className="time" aria-label={`Start at bar ${bar}, beat ${beat}`} title="Position of the playback start line">
        Bar {bar} <em>· beat {beat}</em>
      </span>
      <input
        className="seek"
        type="range"
        aria-label="Playback start position"
        disabled={!ready || documentLoading}
        min={0}
        max={totalBeats}
        step={0.01}
        value={seekBeats ?? timeBeats}
        onChange={(e) => playback.seek(parseFloat(e.target.value))}
      />
    </motion.div>
  );
}
