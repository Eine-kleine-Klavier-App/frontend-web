import { AnimatePresence, motion } from 'motion/react';
import { useSearchParams } from 'react-router-dom';
import { usePreviewPlayback } from '@/core/audio/PreviewPlayer';
import { springPanelBounce } from '@/styles/motion';
import { PreviewPlayButton } from './PreviewPlayButton';
import { ScoreCover } from './ScoreCover';
import { ChevronRightIcon } from '@/ui/icons';

/** Background-preview chrome for the browse shell. It is intentionally a compact overlay dock,
 *  not a layout row: playback should remain reachable across routes without making every grid
 *  reflow. Opening the score's full preview removes this duplicate surface; closing that panel
 *  brings the dock back if the same preview is still playing. */
export function NowPlayingBar({
  hidden,
  onMotionChange,
}: {
  hidden: boolean;
  onMotionChange: (moving: boolean) => void;
}) {
  const { track, phase } = usePreviewPlayback();
  const [searchParams, setSearchParams] = useSearchParams();
  const visible = !!track && !hidden;
  const statusLabel = phase === 'playing' ? 'Now playing' : phase === 'paused' ? 'Paused' : 'Preview finished';

  const openPreview = () => {
    if (!track) return;
    const next = new URLSearchParams(searchParams);
    next.set('preview', track.parentScoreId ?? track.id);
    setSearchParams(next);
  };

  return (
    <div className={'now-playing-slot' + (hidden ? ' is-hidden' : '')}>
      <AnimatePresence initial={false}>
        {visible && track && (
          <motion.aside
            key="now-playing"
            className="now-playing-bar"
            aria-label={statusLabel}
            initial={{ opacity: 0, y: 28, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.98 }}
            transition={springPanelBounce}
            onAnimationStart={() => onMotionChange(true)}
            onAnimationComplete={() => onMotionChange(false)}
          >
            <button
              type="button"
              className="now-playing-open"
              onClick={openPreview}
              aria-label={`Open ${track.title} details`}
            >
              <span className="now-playing-cover" aria-hidden="true">
                <ScoreCover score={track} playable={false} />
              </span>
              <span className="now-playing-copy" aria-live="polite">
                <span className="now-playing-kicker">{statusLabel}</span>
                <span className="now-playing-title">{track.title}</span>
                {track.composer && <span className="now-playing-composer">{track.composer}</span>}
              </span>
              <span className="now-playing-chevron" aria-hidden="true">
                <ChevronRightIcon />
              </span>
            </button>
            <PreviewPlayButton score={track} size="sm" />
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}
