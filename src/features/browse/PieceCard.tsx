import type { ScoreSummary } from '@/core/gateway/LibraryGateway';
import { ScoreCover } from './ScoreCover';

/** Shared catalog card with API metadata. `active` marks the open preview. */
export function PieceCard({
  score,
  onOpen,
  active = false,
  relation,
}: {
  score: ScoreSummary;
  onOpen: (score: ScoreSummary) => void;
  active?: boolean;
  relation?: 'mine' | null;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={'piece-card' + (active ? ' active' : '')}
      onClick={() => onOpen(score)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(score);
        }
      }}
    >
      <div className="piece-card-cover-slot">
        <ScoreCover score={score} />
        {relation && (
          <span className={'pill piece-card-relation piece-card-relation--' + relation}>
            By you
          </span>
        )}
      </div>
      <div className="piece-card-body">
        <span className="piece-card-title">{score.title}</span>
        {score.composer?.trim() && <span className="piece-card-composer">{score.composer}</span>}
      </div>
    </div>
  );
}
