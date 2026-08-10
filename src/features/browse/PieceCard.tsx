import type { ScoreSummary } from '@/core/gateway/LibraryGateway';
import { ScoreCover } from './ScoreCover';
import { FitBadge } from './FitBadge';
import { StarRating } from './StarRating';

/** The one browse card, used in Explore's carousels and Library's grid so the two screens share
 *  one language. Standardized: cover art on top, then title + composer, then the two glance
 *  signals (personalized fit meter + arrangement rating). A div[role=button], not a <button> — the
 *  cover holds its own play button (no nested buttons). `active` marks the card whose preview
 *  panel is open.
 *
 *  `relation` — an optional small corner tag showing the user's existing relationship to this
 *  piece: already saved in one of their collections, or authored by them. The CALLER decides the
 *  label (`PieceCard` stays ignorant of collections/authorship) — only passed in Explore today;
 *  Library's own grid is already implicitly "yours", and an author profile is already implicitly
 *  theirs, so the tag would be redundant noise there. */
export function PieceCard({
  score,
  onOpen,
  active = false,
  relation,
}: {
  score: ScoreSummary;
  onOpen: (score: ScoreSummary) => void;
  active?: boolean;
  relation?: 'mine' | 'saved' | null;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={'piece-card' + (active ? ' active' : '')}
      onClick={() => onOpen(score)}
      onKeyDown={(e) => {
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
            {relation === 'mine' ? 'By you' : 'Saved'}
          </span>
        )}
      </div>
      <div className="piece-card-body">
        <span className="piece-card-title">{score.title}</span>
        <span className="piece-card-composer">{score.composer ?? 'Unknown composer'}</span>
      </div>
      <div className="piece-card-meta">
        <FitBadge fit={score.difficultyFit} />
        <StarRating rating={score.arrangementRating} showValue={false} />
      </div>
    </div>
  );
}
