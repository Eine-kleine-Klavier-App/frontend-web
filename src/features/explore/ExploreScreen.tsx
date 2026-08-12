import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import { CURRENT_AUTHOR_ID } from '@/core/gateway/authorId';
import { useAuthStore } from '@/core/auth/authStore';
import type { Collection, RecommendationShelf, ScoreSummary } from '@/core/gateway/LibraryGateway';
import { PieceCard } from '@/features/browse/PieceCard';
import { ScoreCover } from '@/features/browse/ScoreCover';
import { plateTintClass } from '@/features/browse/plateTint';
import { getGlyphMarkup } from '@/rendering/vexflow/clefGlyph';
import { FitBadge } from '@/features/browse/FitBadge';
import { StarRating } from '@/features/browse/StarRating';
import { PreviewPlayButton } from '@/features/browse/PreviewPlayButton';
import { FadeSwap } from '@/ui/FadeSwap';
import { useScrollEdges } from '@/ui/useScrollEdges';
import { Button } from '@/ui/Button';
import { BrandMark, ChevronLeftIcon, ChevronRightIcon } from '@/ui/icons';
import { BROWSE_QUERY_KEYS, useBrowseQuery } from '@/core/gateway/browseQueryCache';
import { DelayedLoading } from '@/ui/DelayedLoading';

export default function ExploreScreen() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Personalized rows (the hero + recommendation shelves) are user-specific and vanish for an
  // anonymous visitor; only the non-personalized "Trending" shelf stays ([[auth-product-model]]).
  const authStatus = useAuthStore((s) => s.status);
  const authed = authStatus === 'authed';

  const previewId = searchParams.get('preview');
  const query = searchParams.get('q') ?? '';
  const { data: allScores } = useBrowseQuery(
    'public',
    BROWSE_QUERY_KEYS.publicScores,
    () => libraryGateway.listPublicScores(),
  );
  const { data: shelves } = useBrowseQuery<RecommendationShelf[]>(
    'private',
    BROWSE_QUERY_KEYS.recommendations,
    () => libraryGateway.listRecommendations(),
    authed,
  );
  const { data: collections } = useBrowseQuery<Collection[]>(
    'private',
    BROWSE_QUERY_KEYS.myCollections,
    () => libraryGateway.listMyCollections(),
    authed,
  );

  // The user's existing relationship to a piece — shown as a small corner tag on its card.
  const collectedIds = useMemo(() => new Set((collections ?? []).flatMap((c) => c.scoreIds)), [collections]);
  const getRelation = (s: ScoreSummary): 'mine' | 'saved' | null => {
    // "By you" / "Saved" are personal relations — meaningless (and misleading) for an anonymous
    // visitor, so no card tag until signed in.
    if (!authed) return null;
    if (s.authorId === CURRENT_AUTHOR_ID) return 'mine';
    if (collectedIds.has(s.id)) return 'saved';
    return null;
  };

  // A score always opens in the shell's single contextual panel. The URL owns selection so it
  // survives back/forward and the Explore/Library tab switch.
  const open = (s: ScoreSummary) => {
    const next = new URLSearchParams(searchParams);
    next.set('preview', s.id);
    setSearchParams(next);
  };

  const q = query.trim().toLowerCase();
  const searching = q !== '';
  const results = useMemo(() => {
    if (!allScores || !q) return [];
    return allScores.filter(
      (s) => s.title.toLowerCase().includes(q) || (s.composer?.toLowerCase().includes(q) ?? false),
    );
  }, [allScores, q]);

  const hero = authed
    ? (shelves?.find((sh) => sh.preset === 'skill-fit')?.scores[0] ?? shelves?.[0]?.scores[0] ?? null)
    : null;

  // Non-personalized shelf shown to everyone (the only Explore content for anonymous visitors):
  // most-viewed public pieces. viewCount is mock-shaped-as-real like the rest of the catalog.
  const trending = useMemo(
    () => [...(allScores ?? [])].sort((a, b) => b.viewCount - a.viewCount).slice(0, 12),
    [allScores],
  );

  // Not per-item entrance animation on hero/shelves (the route-level transition already animates
  // the whole screen in once — see AppShell — a second one stacked on top was the earlier "text
  // redraw" bug). This FadeSwap covers a DIFFERENT situation: the loading placeholder swapping
  // for real data once the async fetch resolves, which used to hard-pop with zero transition.
  // Anonymous Explore renders only Trending (from allScores), so don't block it on the personalized
  // recommendation fetch — key loading off whichever data this visitor actually sees.
  const contentReady = authed ? shelves !== null : allScores !== null;
  const stateKey = searching ? 'search' : !contentReady ? 'loading' : 'content';

  return (
    <div className="explore">
      <FadeSwap stateKey={stateKey}>
        {searching ? (
          <SearchResults query={query} results={results} onOpen={open} activeId={previewId} getRelation={getRelation} />
        ) : !contentReady ? (
          <DelayedLoading>{authed ? 'Finding pieces for you…' : 'Loading pieces…'}</DelayedLoading>
        ) : (
          <>
            {hero && <Hero score={hero} onOpen={open} />}
            <div className="shelf-stack">
              {/* Personalized shelves only for a signed-in user. */}
              {authed &&
                (shelves ?? []).map((shelf) => {
                  // don't repeat the featured pick inside a shelf — that duplication makes the hero
                  // read as a random "singled-out" card rather than a deliberate top choice.
                  const scores = hero ? shelf.scores.filter((s) => s.id !== hero.id) : shelf.scores;
                  return scores.length === 0 ? null : (
                    <Shelf
                      key={shelf.preset}
                      shelf={{ title: shelf.title, subtitle: shelf.subtitle, scores }}
                      onOpen={open}
                      activeId={previewId}
                      getRelation={getRelation}
                    />
                  );
                })}
              {/* Trending — shown to everyone; the sole shelf for anonymous visitors. */}
              {trending.length > 0 && (
                <Shelf
                  key="trending"
                  shelf={{ title: 'Trending', subtitle: 'Popular on the platform right now', scores: trending }}
                  onOpen={open}
                  activeId={previewId}
                  getRelation={getRelation}
                />
              )}
            </div>
          </>
        )}
      </FadeSwap>
    </div>
  );
}

/** The featured hero — one top skill-fit pick (docs/browse-redesign.md, round 1/2). The engraved
 *  plate carries the title/composer; the side column carries the reason, the two glance signals,
 *  and the actions. Play stays inline (preview here); Practice/Open leave via the panel/route. */
function Hero({ score, onOpen }: { score: ScoreSummary; onOpen: (s: ScoreSummary) => void }) {
  const watermark = useMemo(() => getGlyphMarkup('gClef'), []);
  return (
    <section className={'hero ' + plateTintClass(score.composer)} aria-label="Featured pick">
      {watermark && (
        <svg
          className="hero-watermark"
          viewBox={watermark.viewBox}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: watermark.markup }}
        />
      )}
      <div
        role="button"
        tabIndex={0}
        className="hero-cover"
        onClick={() => onOpen(score)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen(score);
          }
        }}
      >
        {/* Playback has one labeled transport in `.hero-actions`; the cover remains the
            click target for opening details without duplicating global playback state. */}
        <ScoreCover score={score} playable={false} />
      </div>
      <div className="hero-body">
        {/* No "today"/daily framing — a standing recommendation, not a daily prompt, so it stays
            true whether you look at it once or keep coming back to the same pick. */}
        <span className="hero-eyebrow">Recommended for you</span>
        <h2 className="hero-title">{score.title}</h2>
        <span className="hero-composer">{score.composer ?? 'Unknown composer'}</span>
        <div className="hero-signals">
          <FitBadge fit={score.difficultyFit} />
          <StarRating rating={score.arrangementRating} />
        </div>
        <div className="hero-actions">
          <Button variant="primary" onClick={() => onOpen(score)}>
            View piece
          </Button>
          <PreviewPlayButton score={score} size="lg" label />
        </div>
      </div>
    </section>
  );
}

/** A generic browse shelf — a horizontal carousel of piece cards under a titled, reasoned header.
 *  Generic on purpose: recommendation presets fill it now, but "Popular now" / by-composer /
 *  by-genre shelves are just more data later (docs/browse-redesign.md, round 2). Scrolls inside
 *  its own track (never the page — UX rule), with a peek of the next card as an affordance. */
function Shelf({
  shelf,
  onOpen,
  activeId,
  getRelation,
}: {
  // Structural, not `RecommendationShelf` — the same carousel also renders the non-personalized
  // "Trending" shelf (shown to everyone, incl. anonymous), which has no recommendation preset.
  shelf: { title: string; subtitle: string; scores: ScoreSummary[] };
  onOpen: (s: ScoreSummary) => void;
  activeId: string | null;
  getRelation: (s: ScoreSummary) => 'mine' | 'saved' | null;
}) {
  // Don't render an arrow pointing where there's nowhere to go — checked live against the track's
  // real scroll state, not just "more than N cards", so it stays correct if a future "load more"/
  // pagination changes how many cards this shelf holds without anyone having to touch this
  // component (useScrollEdges re-measures on scroll, resize, AND content changes — see its own
  // doc comment).
  const { setTrack, edges: { canScrollLeft, canScrollRight }, trackRef } = useScrollEdges<HTMLDivElement>();
  const nudge = (dir: 1 | -1) => {
    const el = trackRef.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };
  return (
    <section className="shelf" aria-label={shelf.title}>
      <div className="shelf-head">
        <div className="shelf-head-text">
          <h2 className="shelf-title">{shelf.title}</h2>
          <span className="shelf-subtitle">{shelf.subtitle}</span>
        </div>
      </div>
      <div className="shelf-viewport">
        {canScrollLeft && (
          <button type="button" className="shelf-arrow shelf-arrow--left" aria-label="Scroll left" onClick={() => nudge(-1)}>
            <ChevronLeftIcon />
          </button>
        )}
        <div className="shelf-track" ref={setTrack}>
          {shelf.scores.map((s) => (
            <PieceCard key={s.id} score={s} onOpen={onOpen} active={s.id === activeId} relation={getRelation(s)} />
          ))}
        </div>
        {canScrollRight && (
          <button type="button" className="shelf-arrow shelf-arrow--right" aria-label="Scroll right" onClick={() => nudge(1)}>
            <ChevronRightIcon />
          </button>
        )}
      </div>
    </section>
  );
}

function SearchResults({
  query,
  results,
  onOpen,
  activeId,
  getRelation,
}: {
  query: string;
  results: ScoreSummary[];
  onOpen: (s: ScoreSummary) => void;
  activeId: string | null;
  getRelation: (s: ScoreSummary) => 'mine' | 'saved' | null;
}) {
  if (results.length === 0) {
    return (
      <div className="browse-empty">
        <div className="browse-empty-mark" aria-hidden="true">
          <BrandMark />
        </div>
        <h2>Nothing but rests</h2>
        <p>
          No piece matches “{query}”. It may not be in the catalog yet, or try another title or
          composer.
        </p>
      </div>
    );
  }
  return (
    <>
      <span className="browse-result-count">
        {results.length} {results.length === 1 ? 'result' : 'results'} for “{query}”
      </span>
      <div className="piece-grid">
        {results.map((s) => (
          <PieceCard key={s.id} score={s} onOpen={onOpen} active={s.id === activeId} relation={getRelation(s)} />
        ))}
      </div>
    </>
  );
}
