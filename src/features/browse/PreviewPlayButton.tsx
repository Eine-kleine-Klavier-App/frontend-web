import { useSyncExternalStore } from 'react';
import type { ScorePlayback, ScorePlaybackTrack } from '@/core/playback/SavedScorePlayback';
import { PauseIcon, PlayIcon, ReplayIcon } from '@/ui/icons';

/** The same saved-score control in the panel, its versions and the collapsed player. */
export function PreviewPlayButton({ score, transport, size = 'sm', label = false, disabled = false, variant = 'preview' }: {
  score: ScorePlaybackTrack;
  transport: ScorePlayback;
  size?: 'sm' | 'lg';
  label?: boolean;
  disabled?: boolean;
  variant?: 'preview' | 'transport';
}) {
  const phase = useSyncExternalStore(transport.subscribe, () => {
    const state = transport.getState();
    return state.track?.id === score.id ? state.phase : 'idle';
  });
  const action = phase === 'playing' ? 'Pause' : phase === 'paused' ? 'Resume' : phase === 'replay' ? 'Replay' : phase === 'loading' ? 'Cancel loading' : 'Play';
  return <button type="button"
    className={variant === 'transport' ? 'play' : `preview-play preview-play--${size}${label ? ' preview-play--labeled' : ''}${phase === 'replay' ? ' restart' : ''}${phase === 'playing' ? ' playing' : ''}`}
    disabled={disabled} aria-busy={phase === 'loading'} aria-label={`${action} preview of ${score.title}`}
    onClick={event => { event.stopPropagation(); if (variant === 'transport' && phase === 'loading') transport.stopPlayback(); else void transport.play(score); }}>
    {phase === 'playing' ? <PauseIcon /> : variant === 'transport' ? <PlayIcon /> : phase === 'replay' ? <ReplayIcon /> : <PlayIcon />}
    {label && <span>{action === 'Cancel loading' ? action : `${action} preview`}</span>}
  </button>;
}
