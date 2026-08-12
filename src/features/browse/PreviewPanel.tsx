import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion, useMotionValueEvent, useReducedMotion, useTransform } from 'motion/react';
import type { BranchSummary, ScoreSummary } from '@/core/gateway/LibraryGateway';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import { ScoreCover } from './ScoreCover';
import { FitBadge } from './FitBadge';
import { StarRating } from './StarRating';
import { PreviewPlayButton } from './PreviewPlayButton';
import { Button } from '@/ui/Button';
import { ArrowLeftIcon, ChevronRightIcon, CloseIcon, CollapsePanelIcon } from '@/ui/icons';
import { useLayoutSafeSpring, SPRING_PANEL_BOUNCE } from '@/styles/motion';
import { requireAuth } from '@/core/auth/authPrompt';
import { useAuthStore } from '@/core/auth/authStore';
import { withPreview } from './previewRoute';
import { BROWSE_QUERY_KEYS, invalidateBrowseQueries } from '@/core/gateway/browseQueryCache';

const PANEL_W = 372;
// Same injected velocities as the editor's LeftPanel — one panel-motion mechanic, not two
// independently hand-tuned feels (see docs/browse-redesign.md for the reasoning).
const OPEN_OVERSHOOT_VELOCITY = 5; // grows past PANEL_W before settling back to it
const CLOSE_ANTICIPATE_VELOCITY = 6; // kicks toward open a touch before sliding fully out

/** The single score-context surface. It is a reflowing right column on wide screens and the same
 *  component becomes a right-side drawer below that — never a second detail-page interaction.
 *
 *  Motion mechanic mirrors the editor's `LeftPanel` for the right edge: `layout` (critically
 *  damped, monotonic) is the ONLY value driving this panel's own real `width`, so wide content
 *  reflows smoothly with zero bounce while the fixed narrow drawer opens by that same width.
 *  `visual` (bouncy) drives ONLY `.preview-panel-inner`'s fixed-width transform — the panel
 *  content rides its own kick/overshoot as one rigid unit, same as `LeftPanel`'s `.lp-content`.
 *
 *  Mounted from `AppShell`'s FIRST render (`scoreId: string | null`, starts `null`), never gated
 *  on a piece being selected yet: `useLayoutSafeSpring` intentionally skips animating a value on a
 *  component's own first render (so a page that loads already-open, a deep link, doesn't replay
 *  its entrance) — that rule has to fire on a genuine "already open on load" case, not on this
 *  component's first real mount, or every session's first click would silently lose its own
 *  entrance animation. Closed state is `inert` — neither clickable nor tab-reachable at 0 width.
 *
 *  This panel owns the explicit next-step choices: practice, listen, or open an editable draft.
 *  The last action preserves the previous detail screen's auth gate and draft-from-score
 *  semantics without making the user navigate through a duplicate context page first. */
export function PreviewPanel({
  scoreId,
  open,
  onCollapse,
  onClose,
  onMotionChange,
}: {
  scoreId: string | null;
  open: boolean;
  onCollapse: () => void;
  onClose: () => void;
  onMotionChange: (moving: boolean) => void;
}) {
  const navigate = useNavigate();
  const panelRef = useRef<HTMLElement | null>(null);
  const panelScrollRef = useRef<HTMLDivElement | null>(null);
  const { layout, visual } = useLayoutSafeSpring(open, {
    visualSpring: SPRING_PANEL_BOUNCE,
    openVelocity: OPEN_OVERSHOOT_VELOCITY,
    closeVelocity: CLOSE_ANTICIPATE_VELOCITY,
  });
  const layoutWidth = useTransform(layout, (v) => Math.max(0, Math.min(1, v)) * PANEL_W);
  // mirrored sign vs LeftPanel's `(v - 1) * OPEN_W` — this panel opens from the RIGHT edge, so
  // "closed" is a POSITIVE offset (content sits past the right edge) not a negative one.
  const visualX = useTransform(visual, (v) => (1 - v) * PANEL_W);
  const [parentScore, setParentScore] = useState<ScoreSummary | null>(null);
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<{
    parentScoreId: string;
    branch: BranchSummary;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [practiceSoon, setPracticeSoon] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [springMoving, setSpringMoving] = useState(false);
  const reduceMotion = useReducedMotion();
  const authed = useAuthStore((state) => state.status === 'authed');
  const previousOpenRef = useRef(open);
  const selectedBranch = selectedVersion?.parentScoreId === scoreId ? selectedVersion.branch : null;
  const score = selectedBranch ?? parentScore;
  // `open` changes in the render that precedes the spring effect. Including that edge directly
  // hides the panel's native scrollbar before the first moving frame; the state keeps it hidden
  // until the visual spring reports that it has actually settled (no guessed timeout).
  const openChanged = previousOpenRef.current !== open;
  const motionActive = springMoving || openChanged;

  useLayoutEffect(() => {
    if (!openChanged) return;
    previousOpenRef.current = open;
    setSpringMoving(!reduceMotion);
  }, [open, openChanged, reduceMotion]);

  useMotionValueEvent(visual, 'animationComplete', () => setSpringMoving(false));

  // AppShell temporarily makes every scrollbar visually transparent while either of its panels
  // is moving. Report the render-edge too, so the thumbs disappear before the first spring frame,
  // and use the MotionValue's real completion rather than a guessed duration.
  useLayoutEffect(() => {
    onMotionChange(motionActive);
    return () => {
      if (motionActive) onMotionChange(false);
    };
  }, [motionActive, onMotionChange]);

  // React 18 treats `inert` as an unknown non-boolean attribute and drops `{inert: true}`. Set
  // the native DOM property before paint instead: the closed panel and every descendant then
  // leave pointer navigation, sequential focus, and the accessibility tree as one unit.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    if (!open && panel.contains(document.activeElement)) {
      const activeCard = document.querySelector<HTMLElement>('.piece-card.active');
      if (activeCard) activeCard.focus();
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
    panel.inert = !open;
  }, [open]);

  useEffect(() => {
    if (!scoreId) return; // always-mounted; nothing selected yet
    let cancelled = false;
    setLoading(true);
    // Do NOT blank `score`/`branches` here — keep the previous piece's content visible until the
    // new one resolves. A full "Loading…" shows only on the very first open, when there's nothing yet.
    setPracticeSoon(false);
    setError(null);
    void libraryGateway.getScore(scoreId).then((s) => {
      if (!cancelled) {
        setParentScore(s);
        setLoading(false);
      }
    });
    void libraryGateway.listPublicBranches(scoreId).then((b) => !cancelled && setBranches(b));
    return () => {
      cancelled = true;
    };
  }, [scoreId]);

  const showVersion = (branch: BranchSummary) => {
    if (!scoreId) return;
    setSelectedVersion({ parentScoreId: scoreId, branch });
    setPracticeSoon(false);
    setError(null);
    panelScrollRef.current?.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  };

  const showParent = () => {
    setSelectedVersion(null);
    setPracticeSoon(false);
    setError(null);
    panelScrollRef.current?.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  };

  const openInEditor = () =>
    requireAuth(async () => {
      if (!score || busy) return;
      setBusy(true);
      setError(null);
      try {
        const { draftId } = await libraryGateway.createDraft(score.id);
        invalidateBrowseQueries('private', BROWSE_QUERY_KEYS.myDrafts);
        navigate(`/edit/${draftId}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to create a draft.');
      } finally {
        setBusy(false);
      }
    });

  return (
    <motion.aside
      ref={panelRef}
      className="preview-panel"
      aria-label="Piece preview"
      style={{ width: layoutWidth }}
    >
      <motion.div className="preview-panel-inner" style={{ x: visualX }}>
        <div className="preview-panel-toolbar">
          <span className="preview-panel-toolbar-label">Preview</span>
          <div className="preview-panel-controls">
            <button
              type="button"
              className="icon-btn preview-panel-control"
              onClick={onCollapse}
              aria-label="Collapse preview panel"
              title="Collapse preview panel"
            >
              <CollapsePanelIcon />
            </button>
            <button
              type="button"
              className="icon-btn preview-panel-control preview-panel-close"
              onClick={onClose}
              aria-label="Close preview and player"
              title="Close preview and player"
            >
              <CloseIcon />
            </button>
          </div>
        </div>

        <div ref={panelScrollRef} className="preview-panel-content">
          {selectedBranch && parentScore && (
            <button type="button" className="preview-parent-link" onClick={showParent}>
              <ArrowLeftIcon />
              <span className="preview-parent-link-copy">
                <span className="preview-parent-link-label">Back to original</span>
                <span className="preview-parent-link-title">{parentScore.title}</span>
              </span>
            </button>
          )}
          {loading && !score && <div className="preview-panel-loading">Loading…</div>}
          {!loading && !score && (
            <div className="preview-panel-empty">This piece isn’t in the catalog.</div>
          )}

          {score && (
            <div className="preview-panel-body">
              <div className="preview-panel-cover">
                {/* The labeled transport directly below is the panel's one playback action. Repeating
                    the same action as a hover overlay on this adjacent cover adds no capability. */}
                <ScoreCover score={score} playable={false} />
              </div>

              <div className="preview-panel-titleblock">
                <h2 className="preview-panel-title">{score.title}</h2>
                <span className="preview-panel-composer">{score.composer ?? 'Unknown composer'}</span>
                <Link
                  className="preview-panel-author"
                  to={withPreview(`/authors/${score.authorId}`, scoreId)}
                >
                  Arranged by {score.authorName}
                </Link>
              </div>

              <div className="preview-panel-signals">
                {authed && (
                  <div className="preview-panel-signal">
                    <span className="preview-panel-signal-label">Your fit</span>
                    <FitBadge fit={score.difficultyFit} />
                  </div>
                )}
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
                <Button variant="secondary" onClick={openInEditor} disabled={busy}>
                  {busy ? 'Opening…' : 'Open in editor'}
                </Button>
              </div>

              {practiceSoon && (
                <p className="preview-panel-note">
                  Practice mode is coming soon — you’ll play along with live feedback here. For now,
                  listen to the preview or open an editable copy.
                </p>
              )}

              {error && (
                <p className="preview-panel-error" role="alert">
                  {error}
                </p>
              )}

              <button type="button" className="preview-panel-more" disabled>
                See what drives your fit — soon
              </button>

              {branches.length > 0 && (
                <section className="branch-list" aria-label="Other versions">
                  <h3 className="branch-list-head">Other versions</h3>
                  {branches.map((b) => (
                    <div key={b.id} className={'branch-row' + (selectedBranch?.id === b.id ? ' selected' : '')}>
                      <button
                        type="button"
                        className="branch-row-main"
                        aria-current={selectedBranch?.id === b.id ? 'true' : undefined}
                        onClick={() => showVersion(b)}
                      >
                        <span className="branch-row-title">{b.title}</span>
                        <span className="branch-row-author">by {b.authorName}</span>
                        <FitBadge fit={b.difficultyFit} />
                        <span className="branch-row-state">
                          {selectedBranch?.id === b.id ? 'Viewing' : <ChevronRightIcon />}
                        </span>
                      </button>
                      <PreviewPlayButton score={b} size="sm" />
                    </div>
                  ))}
                </section>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </motion.aside>
  );
}
