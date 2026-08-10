import type { ScoreSummary, DraftSummary } from '@/core/gateway/LibraryGateway';
import { previewPlayer, usePreviewPlayingId } from '@/core/audio/PreviewPlayer';
import { scoreToEvents } from '@/core/audio/scoreToEvents';
import { PlayIcon, PauseIcon } from '@/features/editor/icons';

type Previewable = Pick<ScoreSummary | DraftSummary, 'id' | 'title' | 'previewDocument'>;

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
  const playingId = usePreviewPlayingId();
  const isPlaying = playingId === score.id;
  if (!score.previewDocument) return null;

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    void previewPlayer.play(score.id, scoreToEvents(score.previewDocument!));
  };

  return (
    <button
      type="button"
      className={`preview-play preview-play--${size}${label ? ' preview-play--labeled' : ''}${isPlaying ? ' playing' : ''} ${className}`}
      onClick={toggle}
      aria-label={isPlaying ? `Pause preview of ${score.title}` : `Play preview of ${score.title}`}
    >
      {isPlaying ? <PauseIcon /> : <PlayIcon />}
      {label && <span>{isPlaying ? 'Pause preview' : 'Play preview'}</span>}
    </button>
  );
}
