import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { motion, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform } from 'motion/react';
import type { BranchSummary, ScoreSummary } from '@/core/gateway/LibraryGateway';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import type { ScorePlayback } from '@/core/playback/SavedScorePlayback';
import { useAuthStore } from '@/core/auth/authStore';
import { useAuthPrompt } from '@/core/auth/authPrompt';
import { BROWSE_QUERY_KEYS, authorScoresQueryKey, invalidateBrowseQueries } from '@/core/gateway/browseQueryCache';
import { errorMessage } from '@/core/errorMessage';
import { Button } from '@/ui/Button';
import { ChoiceGroup } from '@/ui/ChoiceGroup';
import { OpenInEditorButton } from '@/ui/OpenInEditorButton';
import { PanelToolbar, PanelToolbarControl } from '@/ui/PanelToolbar';
import { ArrowLeftIcon, ChevronRightIcon, CloseIcon, CollapsePanelIcon } from '@/ui/icons';
import { reducedFade, useSidePanelMotion } from '@/styles/motion';
import { ScoreCover } from './ScoreCover';
import { CollectionPicker } from './CollectionPicker';
import { PreviewPlayButton } from './PreviewPlayButton';
import { withPreview } from './previewRoute';

const privacyOptions = [
  { value: 'private', label: 'Private' },
  { value: 'public', label: 'Public' },
];
const message = (cause: unknown) => errorMessage(cause, 'Could not complete this action.');

/** Common saved-score context: a reserved right column or the same drawer over a narrow list. */
export function PreviewPanel({
  scoreId,
  open,
  transport,
  onCollapse,
  onClose,
  onMotionChange,
}: {
  transport: ScorePlayback;
  scoreId: string | null;
  open: boolean;
  onCollapse: () => void;
  onClose: () => void;
  onMotionChange: (moving: boolean) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const currentId = open ? params.get('preview') ?? scoreId : scoreId;
  const lastId = useRef(currentId);
  if (currentId) lastId.current = currentId;
  const id = currentId ?? lastId.current;
  const userId = useAuthStore((state) => state.userId);
  const authOpen = useAuthPrompt((state) => state.isOpen);
  const panelRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const reduce = useReducedMotion();
  const { layout, visual } = useSidePanelMotion(open);
  const panelWidth = useMotionValue(0);
  const layoutWidth = useTransform(() => Math.max(0, Math.min(1, layout.get())) * panelWidth.get());
  // Both aliases share the same quiet progress; reduced motion keeps the surface in place to fade.
  const visualX = useTransform(() => (Math.max(0, Math.min(1, layout.get())) - (reduce ? 1 : visual.get())) * panelWidth.get());
  const [moving, setMoving] = useState(false);
  const [motionIntent, setMotionIntent] = useState(open);
  const motionActive = moving || motionIntent !== open;
  const [parentScore, setParentScore] = useState<ScoreSummary | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<{ parentScoreId: string; score: ScoreSummary; loadedFor: string | null } | null>(null);
  const editingScoreId = selectedVersion?.parentScoreId === id ? selectedVersion.score.id : id;
  const score = selectedVersion?.parentScoreId === id ? (selectedVersion.loadedFor === userId ? selectedVersion.score : null) : parentScore;
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const actionGeneration = useRef(0);
  const locked = useRef(false);
  const ready = !loading && parentScore?.id === id && loadedFor === userId;
  const owner = ready && !!userId && score?.authorId === userId;
  const audioError = useSyncExternalStore(transport.subscribe, () => {
    const state = transport.getState();
    return state.track?.id === score?.id ? state.error : null;
  });

  useLayoutEffect(() => {
    actionGeneration.current++;
    locked.current = false;
    setBusy(false);
  }, [id, open, userId]);

  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const measure = () => panelWidth.set(inner.offsetWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [panelWidth]);
  useLayoutEffect(() => {
    if (motionIntent === open) return;
    setMotionIntent(open);
    setMoving(!reduce);
  }, [open, motionIntent, reduce]);
  useMotionValueEvent(visual, 'animationComplete', () => {
    if (!reduce) setMoving(false);
  });
  useLayoutEffect(() => {
    onMotionChange(motionActive);
    return () => {
      if (motionActive) onMotionChange(false);
    };
  }, [motionActive, onMotionChange]);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.inert = !open || authOpen;
    if (open && !authOpen) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && !panel.contains(active) && (!wasOpen.current || active.closest('.piece-card'))) opener.current = active;
      if (!wasOpen.current) closeRef.current?.focus({ preventScroll: true });
    } else if (!open) {
      if (panel.contains(document.activeElement) || document.activeElement === document.body) {
        const target = opener.current?.isConnected ? opener.current : document.querySelector<HTMLElement>('.piece-card.active, .scoped-search-input');
        if (target) target.focus({ preventScroll: true });
        else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      }
      opener.current = null;
    }
    wasOpen.current = open;
  }, [open, authOpen, id]);

  useEffect(() => {
    const current = ++generation.current;
    if (!open || !id) return;
    setError(null);
    setLoading(true);
    const versionId = selectedVersion?.parentScoreId === id ? selectedVersion.score.id : null;
    void Promise.all([libraryGateway.getScore(id), libraryGateway.listPublicBranches(id), versionId ? libraryGateway.getScore(versionId) : null])
      .then(([value, versions, version]) => {
        if (generation.current !== current) return;
        setParentScore(value);
        setBranches(versions);
        setLoadedFor(userId);
        setLoading(false);
        if (versionId) {
          setSelectedVersion((previous) =>
            previous?.parentScoreId === id && previous.score.id === versionId
              ? version
                ? { parentScoreId: id, score: version, loadedFor: userId }
                : null
              : previous,
          );
        }
        if (!value) setError('This score is unavailable.');
      })
      .catch((cause) => {
        if (generation.current !== current) return;
        setParentScore(null);
        setBranches([]);
        setSelectedVersion(null);
        setLoading(false);
        setError(message(cause));
      });
    return () => {
      generation.current++;
    };
  }, [id, open, userId]);

  const invalidate = (authorId: string | null) => {
    invalidateBrowseQueries('private', BROWSE_QUERY_KEYS.myScores, BROWSE_QUERY_KEYS.myDrafts);
    invalidateBrowseQueries('public', BROWSE_QUERY_KEYS.publicScores, ...(authorId ? [authorScoresQueryKey(authorId)] : []));
  };
  const run = async (action: (current: number) => Promise<void>) => {
    if (locked.current || !ready || !open) return;
    const current = actionGeneration.current;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await action(current);
    } catch (cause) {
      if (actionGeneration.current === current) setError(message(cause));
    } finally {
      if (actionGeneration.current === current) {
        locked.current = false;
        setBusy(false);
      }
    }
  };
  const changePrivacy = (value: string) => {
    if (!score || !owner || score.isPublic === (value === 'public')) return;
    const selected = score;
    void run(async (current) => {
      await libraryGateway.setScoreVisibility(selected.id, value === 'public');
      invalidate(selected.authorId);
      if (actionGeneration.current === current) {
        const updated = { ...selected, isPublic: value === 'public' };
        if (selected.id === id) setParentScore(updated);
        else setSelectedVersion({ parentScoreId: id!, score: updated, loadedFor: userId });
        setBranches((previous) =>
          previous.map((branch) => (branch.id === selected.id ? { ...branch, isPublic: updated.isPublic } : branch)).filter((branch) => branch.isPublic),
        );
      }
    });
  };
  const openScore = () => {
    if (score && ready && !busy) {
      navigate(`/scores/${encodeURIComponent(score.id)}`, {
        state: { returnTo: `${location.pathname}${location.search}` },
      });
    }
  };
  const practiceScore = () => {
    if (score && ready && !busy) {
      navigate(`/scores/${encodeURIComponent(score.id)}/practice`, {
        state: { returnTo: `${location.pathname}${location.search}` },
      });
    }
  };
  const selectBranch = (branch: BranchSummary) => {
    if (!id) return;
    setError(null);
    setSelectedVersion({ parentScoreId: id, score: branch, loadedFor: userId });
    innerRef.current?.querySelector('.preview-panel-content')?.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  };
  const track = score ? { id: score.id, title: score.title, composer: score.composer, ...(score.id !== id && id ? { parentScoreId: id } : {}) } : null;
  const shown = score && loadedFor === userId;

  return (
    <motion.aside ref={panelRef} className="preview-panel" data-open={open} aria-label="Score" aria-hidden={!open} style={{ width: layoutWidth }}>
      <motion.div
        ref={innerRef}
        className="preview-panel-inner"
        style={{ x: visualX }}
        initial={false}
        animate={{ opacity: reduce && !open ? 0 : 1 }}
        transition={reducedFade}
        onAnimationStart={() => {
          if (reduce) setMoving(true);
        }}
        onAnimationComplete={() => {
          if (reduce) setMoving(false);
        }}
      >
        <PanelToolbar label="Preview">
          {shown && userId && <CollectionPicker scoreId={score.id} />}
          <PanelToolbarControl onClick={onCollapse} aria-label="Collapse preview panel" title="Collapse preview panel">
            <CollapsePanelIcon />
          </PanelToolbarControl>
          <PanelToolbarControl ref={closeRef} onClick={onClose} className="preview-panel-close" aria-label="Close preview and player" title="Close preview and player">
            <CloseIcon />
          </PanelToolbarControl>
        </PanelToolbar>
        <div className="preview-panel-content" aria-busy={loading || busy}>
          {selectedVersion?.parentScoreId === id && selectedVersion.loadedFor === userId && loadedFor === userId && parentScore?.id === id && (
            <button type="button" className="preview-parent-link" disabled={!ready || busy} onClick={() => setSelectedVersion(null)}>
              <ArrowLeftIcon />
              <span className="preview-parent-link-copy">
                <span className="preview-parent-link-label">Back to original</span>
                <span className="preview-parent-link-title">{parentScore.title}</span>
              </span>
            </button>
          )}
          {loading && (!score || loadedFor !== userId) && (
            <div className="preview-panel-loading" role="status">
              Loading score…
            </div>
          )}
          {error && (
            <p className="preview-panel-error" role="alert">
              {error}
            </p>
          )}
          <div className="preview-panel-body">
            {shown && (
              <>
                <div className="preview-panel-cover">
                  <ScoreCover score={score} />
                </div>
                <div className="preview-panel-titleblock">
                  <h2 className="preview-panel-title">{score.title}</h2>
                  {score.composer?.trim() && <span className="preview-panel-composer">{score.composer}</span>}
                  {score.authorId && score.authorName && (
                    <Link
                      className="preview-panel-author"
                      to={withPreview(`/authors/${encodeURIComponent(score.authorId)}`, id)}
                      onClick={(event) => {
                        if (!ready) event.preventDefault();
                      }}
                    >
                      Arranged by {score.authorName}
                    </Link>
                  )}
                </div>
              </>
            )}
            <div className="preview-panel-actions">
              {shown && track && <PreviewPlayButton score={track} transport={transport} size="lg" label disabled={!ready} />}
              <Button variant="secondary" onClick={openScore} disabled={!ready || !score || busy}>
                Open score
              </Button>
              <Button variant="secondary" onClick={practiceScore} disabled={!ready || !score || busy}>
                Practice
              </Button>
              {editingScoreId && <OpenInEditorButton scoreId={editingScoreId} disabled={!ready || !score || busy} active={open} />}
            </div>
            {shown && (
              <>
                {audioError && (
                  <p className="preview-panel-error" role="alert">
                    {audioError}
                  </p>
                )}
                {owner && (
                  <fieldset className="score-privacy preview-panel-privacy" disabled={!ready || busy}>
                    <legend>Privacy</legend>
                    <ChoiceGroup ariaLabel="Score privacy" value={score.isPublic ? 'public' : 'private'} onChange={changePrivacy} options={privacyOptions} />
                    <p>{score.isPublic ? 'Visible to everyone in Explore.' : 'Only you can open this score.'}</p>
                  </fieldset>
                )}
                {!!branches.length && (
                  <section className="branch-list" aria-label="Other versions">
                    <h3 className="branch-list-head">Other versions</h3>
                    {branches.map((branch) => (
                      <div key={branch.id} className={'branch-row' + (score.id === branch.id ? ' selected' : '')}>
                        <button
                          type="button"
                          className="branch-row-main"
                          disabled={!ready || busy}
                          aria-current={score.id === branch.id ? 'true' : undefined}
                          onClick={() => selectBranch(branch)}
                        >
                          <span className="branch-row-title">{branch.title}</span>
                          {branch.authorName && <span className="branch-row-author">by {branch.authorName}</span>}
                          <span className="branch-row-state">{score.id === branch.id ? 'Viewing' : <ChevronRightIcon />}</span>
                        </button>
                        <PreviewPlayButton score={branch} transport={transport} size="sm" disabled={!ready} />
                      </div>
                    ))}
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      </motion.div>
    </motion.aside>
  );
}
