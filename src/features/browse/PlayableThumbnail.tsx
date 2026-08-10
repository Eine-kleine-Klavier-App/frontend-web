import type { ScoreDocument } from '@/core/model/score';
import { PlayIcon, PauseIcon } from '@/features/editor/icons';
import { previewPlayer, usePreviewPlayingId } from '@/core/audio/PreviewPlayer';
import { scoreToEvents } from '@/core/audio/scoreToEvents';
import { ScoreThumbnail } from './ScoreThumbnail';

interface Props {
  id: string;
  coverImageUrl: string | null;
  previewDocument: ScoreDocument | null;
  alt: string;
  width?: number;
  height?: number;
  /** Fluid square cover that fills its grid column (Explore/Library grids). */
  fill?: boolean;
}

/** `ScoreThumbnail` plus a hover-reveal play button (Spotify pattern) wired to the global
 *  `previewPlayer` — shared by Explore cards and Library rows. Clicking play never navigates:
 *  this is playback "without opening Practice or the Editor," the whole point of the preview
 *  player being independent of both. */
export function PlayableThumbnail({ id, coverImageUrl, previewDocument, alt, width, height, fill }: Props) {
  const playingId = usePreviewPlayingId();
  const isPlaying = playingId === id;

  const onPlayClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!previewDocument) return;
    void previewPlayer.play(id, scoreToEvents(previewDocument));
  };

  // fixed-size callers scale the button to the thumbnail; fluid (fill) covers use a steady size.
  const ref = Math.min(width ?? 48, height ?? 48);
  const buttonSize = fill ? 40 : Math.round(Math.min(36, Math.max(24, ref * 0.55)));
  const iconSize = Math.round(buttonSize * 0.42);

  return (
    <div className={'playable-thumbnail' + (fill ? ' playable-thumbnail--fill' : '')}>
      <ScoreThumbnail
        id={id}
        coverImageUrl={coverImageUrl}
        previewDocument={previewDocument}
        alt={alt}
        width={width}
        height={height}
        fill={fill}
      />
      {previewDocument && (
        <button
          type="button"
          className={'thumbnail-play' + (isPlaying ? ' playing' : '')}
          style={{ width: buttonSize, height: buttonSize }}
          onClick={onPlayClick}
          title={isPlaying ? 'Pause preview' : 'Play preview'}
          aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
        >
          <span style={{ width: iconSize, height: iconSize }}>{isPlaying ? <PauseIcon /> : <PlayIcon />}</span>
        </button>
      )}
    </div>
  );
}
