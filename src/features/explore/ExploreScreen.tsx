import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import type { ScoreSummary } from '@/core/gateway/LibraryGateway';
import { PieceCard } from '@/features/browse/PieceCard';
import { FadeSwap } from '@/ui/FadeSwap';
import { BrandMark } from '@/ui/icons';
import { BROWSE_QUERY_KEYS, useBrowseQuery } from '@/core/gateway/browseQueryCache';
import { DelayedLoading } from '@/ui/DelayedLoading';
import { errorMessage } from '@/core/errorMessage';

export default function ExploreScreen() {
  const [searchParams, setSearchParams] = useSearchParams();
  const previewId = searchParams.get('preview');
  const query = searchParams.get('q')?.trim() ?? '';
  const { data: scores, status, error } = useBrowseQuery(
    'public', BROWSE_QUERY_KEYS.publicScores, () => libraryGateway.listPublicScores(),
  );
  const visible = useMemo(() => {
    const q = query.toLocaleLowerCase();
    const matching = q
      ? (scores ?? []).filter((score) =>
          score.title.toLocaleLowerCase().includes(q) ||
          (score.composer?.toLocaleLowerCase().includes(q) ?? false))
      : scores ?? [];
    return [...matching].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [scores, query]);

  const open = (score: ScoreSummary) => {
    const next = new URLSearchParams(searchParams);
    next.set('preview', score.id);
    setSearchParams(next);
  };

  return (
    <div className="explore">
      <FadeSwap stateKey={status === 'success' ? (query ? 'search' : 'catalog') : status}>
        {status === 'error' ? (
          <div className="browse-empty" role="alert">{errorMessage(error, 'Could not load scores.')}</div>
        ) : !scores ? (
          <DelayedLoading>Loading pieces…</DelayedLoading>
        ) : visible.length === 0 ? (
          <div className="browse-empty">
            <div className="browse-empty-mark" aria-hidden="true"><BrandMark /></div>
            <h2>{query ? 'Nothing but rests' : 'No published scores yet'}</h2>
            {query && <p>No piece matches “{query}”.</p>}
          </div>
        ) : (
          <section className="library-section" aria-label={query ? 'Search results' : 'Published scores'}>
            <div className="library-section-header">
              <h2>{query ? `Results for “${query}”` : 'Recently updated'}</h2>
              <span className="library-count">{visible.length} {visible.length === 1 ? 'score' : 'scores'}</span>
            </div>
            <div className="piece-grid">
              {visible.map((score) => (
                <PieceCard key={score.id} score={score} onOpen={open} active={score.id === previewId} />
              ))}
            </div>
          </section>
        )}
      </FadeSwap>
    </div>
  );
}
