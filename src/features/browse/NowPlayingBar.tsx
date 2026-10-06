import { useEffect, useRef, useSyncExternalStore } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useSearchParams } from 'react-router-dom';
import type { ScorePlayback } from '@/core/playback/SavedScorePlayback';
import { reducedFade, springPanelBounce } from '@/styles/motion';
import { PreviewPlayButton } from './PreviewPlayButton';
import { ScoreCover } from './ScoreCover';
import { ChevronRightIcon, StopIcon } from '@/ui/icons';

function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function PlaybackTime({ transport }: { transport: ScorePlayback }) {
  const elapsed = useSyncExternalStore(transport.subscribe, () => Math.floor(transport.getState().timeMs / 1000));
  const duration = useSyncExternalStore(transport.subscribe, () => Math.ceil(transport.getState().extentMs / 1000));
  return <span className="time" aria-label={`Playback time ${clock(elapsed)} of ${clock(duration)}`}>
    {clock(elapsed)} <em>/ {clock(duration)}</em>
  </span>;
}

/** The existing compact browse overlay; opening details hides it without touching playback. */
export function NowPlayingBar({ transport, hidden, onMotionChange }: {
  transport: ScorePlayback;
  hidden: boolean;
  onMotionChange: (moving: boolean) => void;
}) {
  const track = useSyncExternalStore(transport.subscribe, () => transport.getState().track);
  const phase = useSyncExternalStore(transport.subscribe, () => transport.getState().phase);
  const error = useSyncExternalStore(transport.subscribe, () => transport.getState().error);
  const [searchParams, setSearchParams] = useSearchParams();
  const reduce = useReducedMotion();
  const visible = !!track && !hidden;
  const bar = useRef<HTMLElement>(null);
  const label = phase === 'playing' ? 'Now playing' : phase === 'paused' ? 'Paused' : phase === 'loading' ? 'Loading audio' : phase === 'error' ? 'Playback unavailable' : phase === 'idle' ? 'Stopped' : 'Preview finished';
  useEffect(() => { if (bar.current) bar.current.inert = !visible; }, [visible]);
  useEffect(() => () => onMotionChange(false), [onMotionChange]);
  const openPreview = () => {
    if (!track) return;
    const next = new URLSearchParams(searchParams);
    next.set('preview', track.parentScoreId ?? track.id);
    setSearchParams(next);
  };
  return <div className={'now-playing-slot' + (hidden ? ' is-hidden' : '')}>
    <AnimatePresence initial={false}>
      {visible && track && <motion.aside key="now-playing" ref={bar} className="now-playing-bar transport" aria-label={label}
        initial={{ opacity: 0, y: reduce ? 0 : 28, scale: reduce ? 1 : .98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: reduce ? 0 : 18, scale: reduce ? 1 : .98 }}
        transition={reduce ? reducedFade : springPanelBounce}
        onAnimationStart={() => onMotionChange(true)} onAnimationComplete={() => onMotionChange(false)}>
        <button type="button" className="now-playing-open" onClick={openPreview} aria-label={`Open ${track.title} details`}>
          <span className="now-playing-cover" aria-hidden="true"><ScoreCover score={track} /></span>
          <span className="now-playing-copy" aria-live="polite">
            <span className="now-playing-kicker">{label}</span>
            <span className="now-playing-title">{track.title}</span>
            {track.composer?.trim() && <span className="now-playing-composer">{track.composer}</span>}
            {error && <span className="now-playing-error" role="alert">{error}</span>}
          </span>
          <span className="now-playing-chevron" aria-hidden="true"><ChevronRightIcon /></span>
        </button>
        <div className="now-playing-controls" role="group" aria-label="Playback">
          <PreviewPlayButton score={track} transport={transport} variant="transport" />
          <button type="button" className="icon-btn ghost" title="Stop" aria-label={`Stop preview of ${track.title}`}
            disabled={phase === 'idle'} onClick={() => transport.stop()}><StopIcon /></button>
          <PlaybackTime transport={transport} />
        </div>
      </motion.aside>}
    </AnimatePresence>
  </div>;
}
