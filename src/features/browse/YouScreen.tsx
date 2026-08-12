import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import { CURRENT_AUTHOR_ID } from '@/core/gateway/authorId';
import { ScoreCover, type Coverable } from './ScoreCover';
import { plateTintClass } from './plateTint';
import { fitTier } from './FitBadge';
import { FadeSwap } from '@/ui/FadeSwap';
import { useAuthStore } from '@/core/auth/authStore';
import { SignInPrompt } from '@/features/auth/SignInPrompt';
import { Button } from '@/ui/Button';
import { ArrowRightIcon, MinusIcon, SignOutIcon, TrendingDownIcon, TrendingUpIcon } from '@/ui/icons';
import { withPreview } from './previewRoute';
import { runAuthSceneTransition } from '@/features/auth/authSceneTransition';
import {
  BROWSE_QUERY_KEYS,
  authorQueryKey,
  authorScoresQueryKey,
  useBrowseQuery,
} from '@/core/gateway/browseQueryCache';
import { DelayedLoading } from '@/ui/DelayedLoading';

/** Your progress — a stats dashboard, deliberately separate from "Your Scores"
 *  (`AuthorProfileScreen`, `/authors/:id`, which keeps the searchable/editable catalog job) — this
 *  page only glances at how you're doing and links onward to it. Three blocks, each honestly
 *  computable from data that already exists elsewhere in the mock (comfort zone from
 *  `difficultyFit`, favorites from practice/listen history) except skill mastery, a shallow mock
 *  (no skill-tracking engine exists yet) — same stance as `difficultyFit` itself: shaped as the
 *  real thing, mocked until the engine lands. */
export default function YouScreen() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const authStatus = useAuthStore((s) => s.status);
  const username = useAuthStore((s) => s.username);
  const signOut = useAuthStore((s) => s.signOut);
  const authed = authStatus === 'authed';
  const { data: author, status: authorStatus } = useBrowseQuery(
    'private',
    authorQueryKey(CURRENT_AUTHOR_ID),
    () => libraryGateway.getAuthor(CURRENT_AUTHOR_ID),
    authed,
  );
  const { data: skills } = useBrowseQuery(
    'private',
    BROWSE_QUERY_KEYS.skillMastery,
    () => libraryGateway.listSkillMastery(),
    authed,
  );
  const { data: scores } = useBrowseQuery(
    'private',
    BROWSE_QUERY_KEYS.myScores,
    () => libraryGateway.listMyScores(),
    authed,
  );
  const { data: practice } = useBrowseQuery(
    'private',
    BROWSE_QUERY_KEYS.recentPractice,
    () => libraryGateway.listRecentPractice(),
    authed,
  );
  const { data: listens } = useBrowseQuery(
    'private',
    BROWSE_QUERY_KEYS.recentListens,
    () => libraryGateway.listRecentListens(),
    authed,
  );
  // Separate from `scores` (`listMyScores` — everything in your library, not just what you wrote)
  // — this is specifically "have you authored anything at all", the gate for the "Your Scores"
  // link below: most users never author a score, so a link into an empty catalog is worse than no
  // link at all.
  const { data: authoredScores } = useBrowseQuery(
    'private',
    authorScoresQueryKey(CURRENT_AUTHOR_ID),
    () => libraryGateway.listAuthorScores(CURRENT_AUTHOR_ID),
    authed,
  );
  const hasAuthored = authoredScores ? authoredScores.length > 0 : null;
  const previewId = searchParams.get('preview');

  const openScore = (scoreId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('preview', scoreId);
    setSearchParams(next);
  };

  const handleSignOut = () => {
    runAuthSceneTransition('sign-out', () => {
      signOut();
      navigate(withPreview('/explore', previewId), { replace: true });
    });
  };

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

  // Prefer the REAL signed-in username (the browse identity below it is still mock — see
  // [[auth-product-model]]); fall back to the mock author name until /auth/me resolves.
  const displayName = username ?? author?.name ?? 'You';
  const initial = displayName.trim().charAt(0).toUpperCase() || '?';
  const loading = authorStatus !== 'success' || !author;
  const stateKey = loading ? 'loading' : 'content';
  const totalScored = comfortZone ? comfortZone.comfortable + comfortZone.reach + comfortZone.stretch : 0;

  // "You" is your personal progress space — logged-in only. A direct hit while anonymous (the nav
  // otherwise prompts sign-in) offers the same prompt rather than rendering an empty dashboard.
  if (authStatus === 'loading') {
    return (
      <div className="you-screen">
        <div className="browse-loading">Restoring your session…</div>
      </div>
    );
  }

  if (authStatus === 'anonymous') {
    return (
      <div className="you-screen">
        <SignInPrompt
          title="You"
          subtitle="Sign in to see your progress, comfort zone, and the pieces you keep coming back to."
        />
      </div>
    );
  }

  return (
    <div className="you-screen">
      <FadeSwap stateKey={stateKey}>
        {loading ? (
          <DelayedLoading>Loading your progress…</DelayedLoading>
        ) : (
          <>
            {/* Account identity and its account-level exit live together. Sign out uses the same
                labeled-button primitive as the rest of browse, but the quiet close-control accent
                treatment keeps it secondary to this progress page's actual content. */}
            <header className={'author-hero you-hero ' + plateTintClass(author.name)}>
              <div className="author-avatar" aria-hidden="true">{initial}</div>
              <div className="author-hero-body">
                <span className="author-hero-eyebrow">Your progress</span>
                <h1 className="author-hero-name">{displayName}</h1>
                <span className="author-hero-handle">{username ? `@${username}` : author.handle}</span>
              </div>
              <Button
                variant="secondary"
                className="you-signout"
                icon={<SignOutIcon />}
                onClick={handleSignOut}
              >
                Sign out
              </Button>
            </header>

            {hasAuthored && (
              <button
                type="button"
                className="you-scores-link"
                onClick={() => navigate(withPreview(`/authors/${CURRENT_AUTHOR_ID}`, previewId))}
              >
                <span>View your scores</span>
                <ArrowRightIcon />
              </button>
            )}

            <section className="library-section" aria-label="Skill mastery">
              <div className="library-section-header">
                <h2>Skill mastery</h2>
              </div>
              {!skills ? (
                <DelayedLoading>Loading…</DelayedLoading>
              ) : (
                <div className="skill-list">
                  {skills.map((s) => {
                    // Direction only, never a number — any percentage (even a delta) would read
                    // as fake precision from a mocked skill model. `level`/`levelMonthAgo` only
                    // ever feed this comparison, never render as text.
                    const trend = s.level > s.levelMonthAgo ? 'up' : s.level < s.levelMonthAgo ? 'down' : 'flat';
                    const TrendIcon = trend === 'up' ? TrendingUpIcon : trend === 'down' ? TrendingDownIcon : MinusIcon;
                    const label = trend === 'up' ? 'Improving' : trend === 'down' ? 'Needs attention' : 'Steady';
                    return (
                      <div key={s.skill} className="skill-row">
                        <span className="skill-row-label">{s.skill}</span>
                        <span className={'pill skill-row-trend skill-row-trend--' + trend}>
                          <TrendIcon />
                          <span>{label}</span>
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
                <DelayedLoading>Loading…</DelayedLoading>
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
                      onClick={() => openScore(f.cover.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openScore(f.cover.id);
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
