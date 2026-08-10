import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion, useTransform } from 'motion/react';
import type { BranchSummary, ScoreSummary } from '@/core/gateway/LibraryGateway';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import { ScoreCover } from './ScoreCover';
import { FitBadge } from './FitBadge';
import { StarRating } from './StarRating';
import { PreviewPlayButton } from './PreviewPlayButton';
import { Button } from '@/ui/Button';
import { CloseIcon } from '@/features/editor/icons';
import { useLayoutSafeSpring, SPRING_PANEL_BOUNCE } from '@/styles/motion';

const PANEL_W = 372;
// Same injected velocities as the editor's LeftPanel — one panel-motion mechanic, not two
// independently hand-tuned feels (see docs/browse-redesign.md for the reasoning).
const OPEN_OVERSHOOT_VELOCITY = 5; // grows past PANEL_W before settling back to it
const CLOSE_ANTICIPATE_VELOCITY = 6; // kicks toward open a touch before sliding fully out

/** The desktop right contextual panel. Selecting a piece opens it here instead of navigating away;
 *  on narrow the full `/scores/:id` route is used instead (`AppShell` decides which).
 *
 *  Motion mechanic mirrors the editor's `LeftPanel` for the right edge: `layout` (critically
 *  damped, monotonic) is the ONLY value driving this panel's own real `width`, so
 *  `.app-shell-content` next to it reflows smoothly with zero bounce of its own. `visual` (bouncy)
 *  drives ONLY `.preview-panel-inner`'s fixed-width transform — the panel content rides its own
 *  kick/overshoot as one rigid unit, same as `LeftPanel`'s `.lp-content`.
 *
 *  Mounted from `AppShell`'s FIRST render (`scoreId: string | null`, starts `null`), never gated
 *  on a piece being selected yet: `useLayoutSafeSpring` intentionally skips animating a value on a
 *  component's own first render (so a page that loads already-open, a deep link, doesn't replay
 *  its entrance) — that rule has to fire on a genuine "already open on load" case, not on this
 *  component's first real mount, or every session's first click would silently lose its own
 *  entrance animation. Closed state is `inert` — neither clickable nor tab-reachable at 0 width.
 *
 *  Deliberately does NOT offer branching a draft directly from here — this is a glance, not a
 *  commitment. "View full score" is the only way onward, landing on `ScoreDetailScreen` (real
 *  notation, its own Play/Practice/Edit) — branching only happens after actually looking at the
 *  piece, never blind from a tinted cover and a fit number. */
export function PreviewPanel({ scoreId, open, onClose }: { scoreId: string | null; open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { layout, visual } = useLayoutSafeSpring(open, {
    visualSpring: SPRING_PANEL_BOUNCE,
    openVelocity: OPEN_OVERSHOOT_VELOCITY,
    closeVelocity: CLOSE_ANTICIPATE_VELOCITY,
  });
  const layoutWidth = useTransform(layout, (v) => Math.max(0, Math.min(1, v)) * PANEL_W);
  // mirrored sign vs LeftPanel's `(v - 1) * OPEN_W` — this panel opens from the RIGHT edge, so
  // "closed" is a POSITIVE offset (content sits past the right edge) not a negative one.
  const visualX = useTransform(visual, (v) => (1 - v) * PANEL_W);
  const [score, setScore] = useState<ScoreSummary | null>(null);
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [practiceSoon, setPracticeSoon] = useState(false);

  useEffect(() => {
    if (!scoreId) return; // always-mounted; nothing selected yet
    let cancelled = false;
    setLoading(true);
    // Do NOT blank `score`/`branches` here — keep the previous piece's content visible until the
    // new one resolves. A full "Loading…" shows only on the very first open, when there's nothing yet.
    setPracticeSoon(false);
    void libraryGateway.getScore(scoreId).then((s) => {
      if (!cancelled) {
        setScore(s);
        setLoading(false);
      }
    });
    void libraryGateway.listPublicBranches(scoreId).then((b) => !cancelled && setBranches(b));
    return () => {
      cancelled = true;
    };
  }, [scoreId]);

  const viewFullScore = () => {
    onClose();
    navigate(`/scores/${scoreId}`);
  };

  return (
    <motion.aside className="preview-panel" aria-label="Piece preview" style={{ width: layoutWidth }} {...(!open ? { inert: true } : {})}>
      <motion.div className="preview-panel-inner" style={{ x: visualX }}>
      <button type="button" className="icon-btn preview-panel-close" onClick={onClose} aria-label="Close preview">
        <CloseIcon />
      </button>

      {loading && !score && <div className="preview-panel-loading">Loading…</div>}
      {!loading && !score && <div className="preview-panel-empty">This piece isn’t in the catalog.</div>}

      {score && (
        <div className="preview-panel-body">
          <div className="preview-panel-cover">
            <ScoreCover score={score} />
          </div>

          <div className="preview-panel-titleblock">
            <h2 className="preview-panel-title">{score.title}</h2>
            <span className="preview-panel-composer">{score.composer ?? 'Unknown composer'}</span>
            <Link className="preview-panel-author" to={`/authors/${score.authorId}`} onClick={onClose}>
              Arranged by {score.authorName}
            </Link>
          </div>

          <div className="preview-panel-signals">
            <div className="preview-panel-signal">
              <span className="preview-panel-signal-label">Your fit</span>
              <FitBadge fit={score.difficultyFit} />
            </div>
            <div className="preview-panel-signal">
              <span className="preview-panel-signal-label">Arrangement</span>
              <StarRating rating={score.arrangementRating} />
            </div>
          </div>

          <div className="preview-panel-actions">
            <Button variant="primary" onClick={() => setPracticeSoon(true)}>
              Practice
            </Button>
            <PreviewPlayButton score={score} size="lg" label />
            <Button variant="secondary" onClick={viewFullScore}>
              View full score
            </Button>
          </div>

          {practiceSoon && (
            <p className="preview-panel-note">
              Practice mode is coming soon — you’ll play along with live feedback here. For now,
              view the full score to look closer or start editing.
            </p>
          )}

          <button type="button" className="preview-panel-more" disabled>
            See what drives your fit — soon
          </button>

          {branches.length > 0 && (
            <section className="branch-list" aria-label="Other versions">
              <h3 className="branch-list-head">Other versions</h3>
              {branches.map((b) => (
                <div key={b.id} className="branch-row">
                  <div className="branch-row-main">
                    <span className="branch-row-title">{b.title}</span>
                    <Link className="branch-row-author" to={`/authors/${b.authorId}`} onClick={onClose}>
                      by {b.authorName}
                    </Link>
                    <FitBadge fit={b.difficultyFit} />
                  </div>
                  <PreviewPlayButton score={b} size="sm" />
                </div>
              ))}
            </section>
          )}
        </div>
      )}
      </motion.div>
    </motion.aside>
  );
}
