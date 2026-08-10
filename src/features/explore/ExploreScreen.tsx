import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import { CURRENT_AUTHOR_ID } from '@/core/gateway/authorId';
import type { Collection, RecommendationShelf, ScoreSummary } from '@/core/gateway/LibraryGateway';
import { PieceCard } from '@/features/browse/PieceCard';
import { ScoreCover } from '@/features/browse/ScoreCover';
import { plateTintClass } from '@/features/browse/plateTint';
import { getGlyphMarkup } from '@/rendering/vexflow/clefGlyph';
import { FitBadge } from '@/features/browse/FitBadge';
import { StarRating } from '@/features/browse/StarRating';
import { PreviewPlayButton } from '@/features/browse/PreviewPlayButton';
import { useIsWide } from '@/features/browse/useIsWide';
import { FadeSwap } from '@/ui/FadeSwap';
import { useScrollEdges } from '@/ui/useScrollEdges';
import { Button } from '@/ui/Button';

export default function ExploreScreen() {
  const navigate = useNavigate();
  const wide = useIsWide();
  const [searchParams, setSearchParams] = useSearchParams();
  const [shelves, setShelves] = useState<RecommendationShelf[] | null>(null);
  const [allScores, setAllScores] = useState<ScoreSummary[] | null>(null);
  const [collections, setCollections] = useState<Collection[] | null>(null);

  const previewId = searchParams.get('preview');
  const query = searchParams.get('q') ?? '';

  useEffect(() => {
    let cancelled = false;
    void libraryGateway.listRecommendations().then((r) => !cancelled && setShelves(r));
    void libraryGateway.listPublicScores().then((r) => !cancelled && setAllScores(r));
    void libraryGateway.listMyCollections().then((r) => !cancelled && setCollections(r));
    return () => {
      cancelled = true;
    };
  }, []);

  // The user's existing relationship to a piece — shown as a small corner tag on its card.
  const collectedIds = useMemo(() => new Set((collections ?? []).flatMap((c) => c.scoreIds)), [collections]);
  const getRelation = (s: ScoreSummary): 'mine' | 'saved' | null => {
    if (s.authorId === CURRENT_AUTHOR_ID) return 'mine';
    if (collectedIds.has(s.id)) return 'saved';
    return null;
  };

  // Card click: on desktop, open the right preview panel (a `?preview=` param the shell reads);
  // on narrow, there's no panel — go to the full-screen detail route. (docs/browse-redesign.md)
  const open = (s: ScoreSummary) => {
    if (wide) {
      const next = new URLSearchParams(searchParams);
      next.set('preview', s.id);
      setSearchParams(next);
    } else {
      navigate(`/scores/${s.id}`);
    }
  };

  const q = query.trim().toLowerCase();
  const searching = q !== '';
  const results = useMemo(() => {
    if (!allScores || !q) return [];
    return allScores.filter(
      (s) => s.title.toLowerCase().includes(q) || (s.composer?.toLowerCase().includes(q) ?? false),
    );
  }, [allScores, q]);

  const hero = shelves?.find((sh) => sh.preset === 'skill-fit')?.scores[0] ?? shelves?.[0]?.scores[0] ?? null;

  // Not per-item entrance animation on hero/shelves (the route-level transition already animates
  // the whole screen in once — see AppShell — a second one stacked on top was the earlier "text
  // redraw" bug). This FadeSwap covers a DIFFERENT situation: the loading placeholder swapping
  // for real data once the async fetch resolves, which used to hard-pop with zero transition.
  const stateKey = searching ? 'search' : !shelves ? 'loading' : 'content';

  return (
    <div className="explore">
      <FadeSwap stateKey={stateKey}>
        {searching ? (
          <SearchResults query={query} results={results} onOpen={open} activeId={previewId} getRelation={getRelation} />
        ) : !shelves ? (
          <div className="browse-loading">Finding pieces for you…</div>
        ) : (
          <>
            {hero && <Hero score={hero} onOpen={open} />}
            <div className="shelf-stack">
              {shelves.map((shelf) => {
                // don't repeat the featured pick inside a shelf — that duplication makes the hero
                // read as a random "singled-out" card rather than a deliberate top choice.
                const scores = hero ? shelf.scores.filter((s) => s.id !== hero.id) : shelf.scores;
                return scores.length === 0 ? null : (
                  <Shelf
                    key={shelf.preset}
                    shelf={{ ...shelf, scores }}
                    onOpen={open}
                    activeId={previewId}
                    getRelation={getRelation}
                  />
                );
              })}
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
        <ScoreCover score={score} />
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
  shelf: RecommendationShelf;
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
            ‹
          </button>
        )}
        <div className="shelf-track" ref={setTrack}>
          {shelf.scores.map((s) => (
            <PieceCard key={s.id} score={s} onOpen={onOpen} active={s.id === activeId} relation={getRelation(s)} />
          ))}
        </div>
        {canScrollRight && (
          <button type="button" className="shelf-arrow shelf-arrow--right" aria-label="Scroll right" onClick={() => nudge(1)}>
            ›
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
          ♪ · · ·
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
