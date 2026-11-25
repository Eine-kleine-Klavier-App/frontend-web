import { useEffect } from 'react';
import type { MotionValue } from 'motion/react';
import { useNavigationValue } from '@/core/navigation/ScoreNavigation';
import { playback, usePlaybackValue } from '@/core/playback/PlaybackController';
import { Transport, type TransportScrub } from './Transport';

/** What moves the position by hand in the editor: the sound player. */
export const playbackScrub: TransportScrub = {
  begin: () => playback.beginScrub(),
  to: (ms) => playback.scrubTo(ms),
  end: (ms) => playback.endScrub(ms),
};

/** The editor's transport over the sound player. */
export function PlaybackBar({ shift }: { shift?: MotionValue<number> }) {
  // Single values, so the bar renders when one of them changes; the position itself is drawn on the animation frame.
  const playing = usePlaybackValue((state) => state.playing);
  const loading = usePlaybackValue((state) => state.loading);
  const paused = usePlaybackValue((state) => state.paused);
  const ready = usePlaybackValue((state) => state.ready);
  // the island and the line on the score need the playback plan to show a position and to be moved, before anything has played, and again after an edit has dropped it
  const planned = useNavigationValue((state) => state.map !== null);
  useEffect(() => {
    if (ready && !planned) void playback.prepareMap();
  }, [ready, planned]);
  return (
    <Transport
      shift={shift}
      loading={loading}
      playing={playing}
      paused={paused}
      disabled={!ready}
      stopDisabled={!ready}
      onPlay={() => void playback.play()}
      onPause={() => playback.pause()}
      onStop={() => playback.stop()}
      onSeekMs={(ms) => playback.seekMs(ms)}
      scrub={playbackScrub}
    />
  );
}
