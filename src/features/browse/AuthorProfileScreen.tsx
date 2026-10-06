import { useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import type { ScoreSummary } from '@/core/gateway/LibraryGateway';
import { PieceCard } from './PieceCard';
import { plateTintClass } from './plateTint';
import { FadeSwap } from '@/ui/FadeSwap';
import { useAuthStore } from '@/core/auth/authStore';
import { BROWSE_QUERY_KEYS, authorScoresQueryKey, useBrowseQuery } from '@/core/gateway/browseQueryCache';
import { DelayedLoading } from '@/ui/DelayedLoading';
import { errorMessage } from '@/core/errorMessage';

export default function AuthorProfileScreen() {
  const { authorId = '' } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const userId = useAuthStore((s) => s.userId);
  const username = useAuthStore((s) => s.username);
  const isMe = userId !== null && authorId === userId;
  const { data: scores, status, error } = useBrowseQuery(
    isMe ? 'private' : 'public',
    isMe ? BROWSE_QUERY_KEYS.myScores : authorScoresQueryKey(authorId),
    () => isMe ? libraryGateway.listMyScores() : libraryGateway.listAuthorScores(authorId),
    Boolean(authorId),
  );
  const previewId = searchParams.get('preview');
  const q = searchParams.get('q')?.trim().toLocaleLowerCase() ?? '';
  const visible = useMemo(() => (scores ?? []).filter((score) =>
    !q || score.title.toLocaleLowerCase().includes(q) ||
    (score.composer?.toLocaleLowerCase().includes(q) ?? false)), [scores, q]);
  const name = isMe ? username ?? 'You' : scores?.[0]?.authorName ?? 'Author';
  const initial = name.trim().charAt(0).toLocaleUpperCase() || '?';
  const open = (score: ScoreSummary) => {
    const next = new URLSearchParams(searchParams);
    next.set('preview', score.id);
    setSearchParams(next);
  };

  return (
    <div className="author-screen">
      <FadeSwap stateKey={status === 'success' ? 'content' : status}>
        {status === 'error' ? (
          <div className="browse-empty" role="alert">{errorMessage(error, 'Could not load scores.')}</div>
        ) : !scores ? (
          <DelayedLoading>Loading scores…</DelayedLoading>
        ) : (
          <>
            <header className={'author-hero ' + plateTintClass(name)}>
              <div className="author-avatar" aria-hidden="true">{initial}</div>
              <div className="author-hero-body">
                <span className="author-hero-eyebrow">{isMe ? 'Your scores' : 'Author'}</span>
                <h1 className="author-hero-name">{name}</h1>
                <span className="author-hero-stat">{scores.length} {scores.length === 1 ? 'score' : 'scores'}</span>
              </div>
            </header>
            <section className="library-section">
              <div className="library-section-header"><h2>{isMe ? 'Your scores' : 'Published scores'}</h2></div>
              {visible.length === 0 ? (
                <div className="library-empty">{q ? 'No scores match your search.' : 'No scores here yet.'}</div>
              ) : (
                <div className="piece-grid">
                  {visible.map((score) => (
                    <PieceCard key={score.id} score={score} onOpen={open} active={score.id === previewId} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </FadeSwap>
    </div>
  );
}
