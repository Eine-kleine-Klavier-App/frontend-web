import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import { CURRENT_AUTHOR_ID } from '@/core/gateway/authorId';
import type { Author, ListenSummary, PracticeSummary, ScoreSummary, SkillMastery } from '@/core/gateway/LibraryGateway';
import { ScoreCover, type Coverable } from './ScoreCover';
import { plateTintClass } from './plateTint';
import { fitTier } from './FitBadge';
import { FadeSwap } from '@/ui/FadeSwap';

/** Your progress — a stats dashboard, deliberately separate from "Your Scores"
 *  (`AuthorProfileScreen`, `/authors/:id`, which keeps the searchable/editable catalog job) — this
 *  page only glances at how you're doing and links onward to it. Three blocks, each honestly
 *  computable from data that already exists elsewhere in the mock (comfort zone from
 *  `difficultyFit`, favorites from practice/listen history) except skill mastery, a shallow mock
 *  (no skill-tracking engine exists yet) — same stance as `difficultyFit` itself: shaped as the
 *  real thing, mocked until the engine lands. */
export default function YouScreen() {
  const navigate = useNavigate();
  const [author, setAuthor] = useState<Author | null>(null);
  const [skills, setSkills] = useState<SkillMastery[] | null>(null);
  const [scores, setScores] = useState<ScoreSummary[] | null>(null);
  const [practice, setPractice] = useState<PracticeSummary[] | null>(null);
  const [listens, setListens] = useState<ListenSummary[] | null>(null);
  // Separate from `scores` (`listMyScores` — everything in your library, not just what you wrote)
  // — this is specifically "have you authored anything at all", the gate for the "Your Scores"
  // link below: most users never author a score, so a link into an empty catalog is worse than no
  // link at all.
  const [hasAuthored, setHasAuthored] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    void libraryGateway.getAuthor(CURRENT_AUTHOR_ID).then((a) => !cancelled && setAuthor(a));
    void libraryGateway.listSkillMastery().then((r) => !cancelled && setSkills(r));
    void libraryGateway.listMyScores().then((r) => !cancelled && setScores(r));
    void libraryGateway.listRecentPractice().then((r) => !cancelled && setPractice(r));
    void libraryGateway.listRecentListens().then((r) => !cancelled && setListens(r));
    void libraryGateway.listAuthorScores(CURRENT_AUTHOR_ID).then((r) => !cancelled && setHasAuthored(r.length > 0));
    return () => {
      cancelled = true;
    };
  }, []);

  const comfortZone = useMemo(() => {
    if (!scores) return null;
    const counts = { comfortable: 0, reach: 0, stretch: 0 };
    for (const s of scores) {
      const { cls } = fitTier(s.difficultyFit);
      if (cls === 'fit--comfortable') counts.comfortable++;
      else if (cls === 'fit--reach') counts.reach++;
      else counts.stretch++;
    }
    return counts;
  }, [scores]);

  // "Pieces you keep coming back to" — merges practice + listen history (the only two activity
  // signals that exist), newest first. Deliberately NOT a fabricated "play count": the mock has no
  // such field, and this stays honest to the data that's actually there.
  const favorites = useMemo(() => {
    type Fav = { key: string; cover: Coverable; title: string; when: number; progress?: number };
    const items: Fav[] = [
      ...(practice ?? []).map((p) => ({ key: `p-${p.id}`, cover: p, title: p.title, when: new Date(p.lastPracticedAt).getTime(), progress: p.progress })),
      ...(listens ?? []).map((l) => ({ key: `l-${l.id}`, cover: l, title: l.title, when: new Date(l.listenedAt).getTime() })),
    ];
    return items.sort((a, b) => b.when - a.when);
  }, [practice, listens]);

  const initial = author?.name.trim().charAt(0).toUpperCase() || '?';
  const loading = !author;
  const stateKey = loading ? 'loading' : 'content';
  const totalScored = comfortZone ? comfortZone.comfortable + comfortZone.reach + comfortZone.stretch : 0;

  return (
    <div className="you-screen">
      <FadeSwap stateKey={stateKey}>
        {loading ? (
          <div className="browse-loading">Loading your progress…</div>
        ) : (
          <>
            {/* Pure identity — no action here. A single lone button in a tinted band would read
                as this page's main action, but it's a secondary exit link, not this screen's job
                — see the "Your Scores" link below instead, which only renders once you've
                authored something. */}
            <header className={'author-hero ' + plateTintClass(author.name)}>
              <div className="author-avatar" aria-hidden="true">{initial}</div>
              <div className="author-hero-body">
                <span className="author-hero-eyebrow">Your progress</span>
                <h1 className="author-hero-name">{author.name}</h1>
                <span className="author-hero-handle">{author.handle}</span>
              </div>
            </header>

            {hasAuthored && (
              <button type="button" className="you-scores-link" onClick={() => navigate(`/authors/${CURRENT_AUTHOR_ID}`)}>
                View your scores →
              </button>
            )}

            <section className="library-section" aria-label="Skill mastery">
              <div className="library-section-header">
                <h2>Skill mastery</h2>
              </div>
              {!skills ? (
                <div className="browse-loading">Loading…</div>
              ) : (
                <div className="skill-list">
                  {skills.map((s) => {
                    // Direction only, never a number — any percentage (even a delta) would read
                    // as fake precision from a mocked skill model. `level`/`levelMonthAgo` only
                    // ever feed this comparison, never render as text.
                    const trend = s.level > s.levelMonthAgo ? 'up' : s.level < s.levelMonthAgo ? 'down' : 'flat';
                    const arrow = trend === 'up' ? '▲' : trend === 'down' ? '▼' : '–';
                    const label = trend === 'up' ? 'Improving' : trend === 'down' ? 'Needs attention' : 'Steady';
                    return (
                      <div key={s.skill} className="skill-row">
                        <span className="skill-row-label">{s.skill}</span>
                        <span className={'pill skill-row-trend skill-row-trend--' + trend}>
                          {arrow} {label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            <section className="library-section" aria-label="Comfort zone">
              <div className="library-section-header">
                <h2>Comfort zone</h2>
                {comfortZone && <span className="library-count">{totalScored} scores</span>}
              </div>
              {!comfortZone ? (
                <div className="browse-loading">Loading…</div>
              ) : totalScored === 0 ? (
                <div className="library-empty">No scores yet — save a few to see how they fit you.</div>
              ) : (
                <>
                  <div className="comfort-bar" aria-hidden="true">
                    <span className="comfort-bar-segment fit--comfortable" style={{ flexGrow: comfortZone.comfortable }} />
                    <span className="comfort-bar-segment fit--reach" style={{ flexGrow: comfortZone.reach }} />
                    <span className="comfort-bar-segment fit--stretch" style={{ flexGrow: comfortZone.stretch }} />
                  </div>
                  <div className="comfort-legend">
                    <span className="comfort-legend-item">
                      <span className="comfort-legend-dot fit--comfortable" />
                      Comfortable · {comfortZone.comfortable}
                    </span>
                    <span className="comfort-legend-item">
                      <span className="comfort-legend-dot fit--reach" />
                      Within reach · {comfortZone.reach}
                    </span>
                    <span className="comfort-legend-item">
                      <span className="comfort-legend-dot fit--stretch" />
                      A stretch · {comfortZone.stretch}
                    </span>
                  </div>
                </>
              )}
            </section>

            <section className="library-section" aria-label="Pieces you keep coming back to">
              <div className="library-section-header">
                <h2>Pieces you keep coming back to</h2>
              </div>
              {favorites.length === 0 ? (
                <div className="library-empty">Practice or preview a few pieces to see them here.</div>
              ) : (
                <div className="jump-track">
                  {favorites.slice(0, 6).map((f) => (
                    <div
                      key={f.key}
                      role="button"
                      tabIndex={0}
                      className="work-card"
                      onClick={() => navigate(`/scores/${f.cover.id}`)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          navigate(`/scores/${f.cover.id}`);
                        }
                      }}
                    >
                      <div className="work-card-thumb">
                        <ScoreCover score={f.cover} playable={false} />
                      </div>
                      <div className="work-card-main">
                        <span className="work-card-title">{f.title}</span>
                        {f.progress !== undefined && (
                          <span className="work-card-progress" aria-label={`${Math.round(f.progress * 100)}% practiced`}>
                            <span className="work-card-progress-fill" style={{ width: `${Math.round(f.progress * 100)}%` }} />
                          </span>
                        )}
                      </div>
                    </div>
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
