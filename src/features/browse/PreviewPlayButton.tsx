import {
  previewControlPhase,
  previewPlayer,
  usePreviewPlayback,
  type PreviewTrack,
} from '@/core/audio/PreviewPlayer';
import { scoreToEvents } from '@/core/audio/scoreToEvents';
import { PauseIcon, PlayIcon, ReplayIcon } from '@/ui/icons';

type Previewable = PreviewTrack;

/** The one preview play/pause control, reused by plates, the hero, and the right panel —
 *  playback lives everywhere now, not just the editor (docs/browse-redesign.md). Renders
 *  nothing when the piece has no preview document. `size` = 'sm' on cover overlays, 'lg' for
 *  the hero/panel. `label` shows a text label beside the icon (hero/panel wide buttons). */
export function PreviewPlayButton({
  score,
  size = 'sm',
  label = false,
  className = '',
}: {
  score: Previewable;
  size?: 'sm' | 'lg';
  label?: boolean;
  className?: string;
}) {
  const playback = usePreviewPlayback();
  const phase = previewControlPhase(playback, score.id);
  const isPlaying = phase === 'playing';
  const isPaused = phase === 'paused';
  const canReplay = phase === 'replay';
  if (!score.previewDocument) return null;

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    void previewPlayer.play(score, scoreToEvents(score.previewDocument!));
  };

  return (
    <button
      type="button"
      className={`preview-play preview-play--${size}${label ? ' preview-play--labeled' : ''}${canReplay ? ' restart' : ''}${isPlaying ? ' playing' : ''} ${className}`}
      onClick={toggle}
      aria-label={
        isPlaying
          ? `Pause preview of ${score.title}`
          : isPaused
            ? `Resume preview of ${score.title}`
          : canReplay
            ? `Replay preview of ${score.title}`
            : `Play preview of ${score.title}`
      }
    >
      {isPlaying ? <PauseIcon /> : canReplay ? <ReplayIcon /> : <PlayIcon />}
      {label && (
        <span>{isPlaying ? 'Pause preview' : isPaused ? 'Resume preview' : canReplay ? 'Replay preview' : 'Play preview'}</span>
      )}
    </button>
  );
}
