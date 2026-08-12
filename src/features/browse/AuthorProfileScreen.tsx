import { useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import { requireAuth } from '@/core/auth/authPrompt';
import { CURRENT_AUTHOR_ID } from '@/core/gateway/authorId';
import type { Author, ScoreSummary } from '@/core/gateway/LibraryGateway';
import { PieceCard } from './PieceCard';
import { ScoreCover } from './ScoreCover';
import { StarRating } from './StarRating';
import { FitBadge } from './FitBadge';
import { plateTintClass } from './plateTint';
import { Button } from '@/ui/Button';
import { FadeSwap } from '@/ui/FadeSwap';
import { useAuthStore } from '@/core/auth/authStore';
import {
  BROWSE_QUERY_KEYS,
  authorQueryKey,
  authorScoresQueryKey,
  invalidateBrowseQueries,
  updateBrowseQuery,
  useBrowseQuery,
  type BrowseQueryScope,
} from '@/core/gateway/browseQueryCache';
import { DelayedLoading } from '@/ui/DelayedLoading';

/** Author profile (`/authors/:authorId`) — every arrangement an author has published; reached by
 *  clicking an author's name, or via a "Your Scores" link from `/you` when it's your own. Two
 *  genuinely different jobs share this route:
 *  - **Someone else's profile** — a public, read-only introduction (bio, handle, arrangement
 *    count) over their catalog — `AuthorProfileContent`.
 *  - **Your own** (`author.isMe`) — a management panel: quick access to your own scores, split
 *    private/public with a one-click move between them, views + rating (not a personal difficulty
 *    fit — that's meaningless for your OWN piece). No bio hero, no "Published" label — the route
 *    already says what this is — `MyScoresContent`. */
export default function AuthorProfileScreen() {
  const { authorId = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authStatus = useAuthStore((s) => s.status);
  const canSeePrivate = authStatus === 'authed' && authorId === CURRENT_AUTHOR_ID;
  const queryScope: BrowseQueryScope = canSeePrivate ? 'private' : 'public';
  const authorKey = authorQueryKey(authorId);
  const scoresKey = authorScoresQueryKey(authorId);
  const { data: author, status: authorStatus } = useBrowseQuery(
    queryScope,
    authorKey,
    () => libraryGateway.getAuthor(authorId),
  );
  const { data: scores } = useBrowseQuery(
    queryScope,
    scoresKey,
    async () => {
      const items = await libraryGateway.listAuthorScores(authorId);
      return canSeePrivate ? items : items.filter((item) => item.isPublic);
    },
  );

  const previewId = searchParams.get('preview');
  // Every author profile reads the shell's one `?q`. Public profiles and your own scores therefore
  // keep search in exactly the same fixed topbar position as Explore and Library.
  const q = searchParams.get('q') ?? '';

  const open = (s: ScoreSummary) => {
    const next = new URLSearchParams(searchParams);
    next.set('preview', s.id);
    setSearchParams(next);
  };

  const newScore = () =>
    requireAuth(async () => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const { draftId } = await libraryGateway.createDraft();
        invalidateBrowseQueries('private', BROWSE_QUERY_KEYS.myDrafts);
        navigate(`/edit/${draftId}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to create a draft.');
      } finally {
        setBusy(false);
      }
    });

  const isMe = authStatus === 'authed' && (author?.isMe ?? authorId === CURRENT_AUTHOR_ID);
  const activeQuery = q;
  const visible = useMemo(() => {
    if (!scores) return null;
    // Effects clear/refetch after paint. Filter against the CURRENT auth state as well so a
    // sign-out cannot expose one stale render of private scores from the previous authed state.
    const accessible = isMe ? scores : scores.filter((score) => score.isPublic);
    const needle = activeQuery.trim().toLowerCase();
    if (!needle) return accessible;
    return accessible.filter(
      (s) => s.title.toLowerCase().includes(needle) || (s.composer?.toLowerCase().includes(needle) ?? false),
    );
  }, [scores, activeQuery, isMe]);

  // Optimistic — the mock can't fail, so no revert-on-error branch (nothing to add error handling FOR).
  const toggleVisibility = (score: ScoreSummary) => {
    const nextPublic = !score.isPublic;
    const updateScore = (items: ScoreSummary[]) =>
      items.map((item) => (item.id === score.id ? { ...item, isPublic: nextPublic } : item));
    updateBrowseQuery('private', scoresKey, updateScore);
    updateBrowseQuery('private', BROWSE_QUERY_KEYS.myScores, updateScore);
    invalidateBrowseQueries('public', BROWSE_QUERY_KEYS.publicScores, scoresKey);
    invalidateBrowseQueries('private', BROWSE_QUERY_KEYS.recommendations);
    void libraryGateway.setScoreVisibility(score.id, nextPublic);
  };

  const initial = author?.name.trim().charAt(0).toUpperCase() || '?';
  const loading = authorStatus !== 'success';
  const stateKey = loading ? 'loading' : !author ? 'not-found' : 'profile';

  return (
    <div className="author-screen">
      <FadeSwap stateKey={stateKey}>
        {loading ? (
          <DelayedLoading>Loading profile…</DelayedLoading>
        ) : !author ? (
          <div className="browse-empty">
            <h2>Author not found</h2>
            <p>This profile doesn’t exist yet.</p>
          </div>
        ) : isMe ? (
          <MyScoresContent
            scores={scores}
            visible={visible}
            previewId={previewId}
            open={open}
            busy={busy}
            newScore={newScore}
            error={error}
            toggleVisibility={toggleVisibility}
            searching={activeQuery.trim() !== ''}
          />
        ) : (
          <AuthorProfileContent
            author={author}
            scores={scores}
            visible={visible}
            previewId={previewId}
            open={open}
            initial={initial}
          />
        )}
      </FadeSwap>
    </div>
  );
}

/** Someone ELSE's profile — unchanged (docs/browse-redesign.md, round 4/9). */
function AuthorProfileContent({
  author,
  scores,
  visible,
  previewId,
  open,
  initial,
}: {
  author: Author;
  scores: ScoreSummary[] | null;
  visible: ScoreSummary[] | null;
  previewId: string | null;
  open: (s: ScoreSummary) => void;
  initial: string;
}) {
  return (
    <>
      <header className={'author-hero ' + plateTintClass(author.name)}>
        <div className="author-avatar" aria-hidden="true">{initial}</div>
        <div className="author-hero-body">
          <span className="author-hero-eyebrow">Author</span>
          <h1 className="author-hero-name">{author.name}</h1>
          <span className="author-hero-handle">{author.handle}</span>
          {author.bio && <p className="author-hero-bio">{author.bio}</p>}
          <span className="author-hero-stat">
            {scores ? `${scores.length} ${scores.length === 1 ? 'arrangement' : 'arrangements'}` : '—'}
          </span>
        </div>
      </header>

      <div className="author-toolbar">
        <h2 className="author-section-title">Arrangements</h2>
      </div>

      <FadeSwap stateKey={!visible ? 'loading' : visible.length === 0 ? 'empty' : 'content'}>
        {!visible ? (
          <DelayedLoading>Loading…</DelayedLoading>
        ) : visible.length === 0 ? (
          <div className="library-empty">Nothing published yet.</div>
        ) : (
          <div className="piece-grid">
            {visible.map((s) => (
              <PieceCard key={s.id} score={s} onOpen={open} active={s.id === previewId} />
            ))}
          </div>
        )}
      </FadeSwap>
    </>
  );
}

/** YOUR own scores — a management panel, not a public introduction. No hero, no bio, no
 *  "Published" label; split private/public, each movable to the other. */
function MyScoresContent({
  scores,
  visible,
  previewId,
  open,
  busy,
  newScore,
  error,
  toggleVisibility,
  searching,
}: {
  scores: ScoreSummary[] | null;
  visible: ScoreSummary[] | null;
  previewId: string | null;
  open: (s: ScoreSummary) => void;
  busy: boolean;
  newScore: () => void;
  error: string | null;
  toggleVisibility: (s: ScoreSummary) => void;
  searching: boolean;
}) {
  const publicScores = visible?.filter((s) => s.isPublic) ?? null;
  const privateScores = visible?.filter((s) => !s.isPublic) ?? null;

  return (
    <>
      <header className="library-header">
        <h1>Your Scores</h1>
        <Button variant="primary" disabled={busy} onClick={() => void newScore()}>
          New score
        </Button>
      </header>

      {error && <div className="library-error">{error}</div>}

      <FadeSwap stateKey={!visible ? 'loading' : 'content'}>
        {!visible || !publicScores || !privateScores ? (
          <DelayedLoading>Loading…</DelayedLoading>
        ) : (
          <>
            <ScoreVisibilitySection
              title="Public"
              scores={publicScores}
              emptyLabel={searching ? 'No matches in your public scores.' : 'Nothing public yet — make a score public to share it.'}
              previewId={previewId}
              open={open}
              toggleVisibility={toggleVisibility}
            />
            <ScoreVisibilitySection
              title="Private"
              scores={privateScores}
              emptyLabel={searching ? 'No matches in your private scores.' : 'Nothing private — every score you have is public.'}
              previewId={previewId}
              open={open}
              toggleVisibility={toggleVisibility}
            />
          </>
        )}
      </FadeSwap>
    </>
  );
}

function ScoreVisibilitySection({
  title,
  scores,
  emptyLabel,
  previewId,
  open,
  toggleVisibility,
}: {
  title: string;
  scores: ScoreSummary[];
  emptyLabel: string;
  previewId: string | null;
  open: (s: ScoreSummary) => void;
  toggleVisibility: (s: ScoreSummary) => void;
}) {
  return (
    <section className="library-section" aria-label={title}>
      <div className="library-section-header">
        <h2>{title}</h2>
        <span className="library-count">{scores.length}</span>
      </div>
      {scores.length === 0 ? (
        <div className="library-empty">{emptyLabel}</div>
      ) : (
        <div className="piece-grid">
          {scores.map((s) => (
            <AuthorScoreCard key={s.id} score={s} onOpen={open} active={s.id === previewId} onToggleVisibility={toggleVisibility} />
          ))}
        </div>
      )}
    </section>
  );
}

/** A card for YOUR OWN score — same cover/body/meta language as `PieceCard` (unification, not a
 *  lookalike: same `.piece-card`/`.piece-card-cover-slot`/`.piece-card-body`/`.piece-card-meta`
 *  classes, same `FitBadge`+`StarRating` pair). Two things ADDED on top of the standard card: a
 *  view count, and a visibility-move action — a second, separate interactive element inside a
 *  `role=button` card, same `stopPropagation` pattern `PreviewPlayButton` already uses inside
 *  `ScoreCover`. */
function AuthorScoreCard({
  score,
  onOpen,
  active,
  onToggleVisibility,
}: {
  score: ScoreSummary;
  onOpen: (s: ScoreSummary) => void;
  active: boolean;
  onToggleVisibility: (s: ScoreSummary) => void;
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
      </div>
      <div className="piece-card-body">
        <span className="piece-card-title">{score.title}</span>
        <span className="piece-card-composer">{score.composer ?? 'Unknown composer'}</span>
      </div>
      <div className="piece-card-meta">
        <FitBadge fit={score.difficultyFit} />
        <StarRating rating={score.arrangementRating} showValue={false} />
      </div>
      <span className="author-score-views">{score.viewCount} views</span>
      <Button
        variant="ghost"
        className="author-score-toggle"
        onClick={(e) => {
          e.stopPropagation();
          onToggleVisibility(score);
        }}
      >
        {score.isPublic ? 'Make private' : 'Make public'}
      </Button>
    </div>
  );
}
