import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEditor } from '@/app/store';
import { useAuthStore } from '@/core/auth/authStore';
import { AuthRequiredError } from '@/core/auth/authorizedFetch';
import { useAuthPrompt } from '@/core/auth/authPrompt';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import { BROWSE_QUERY_KEYS, invalidateBrowseQueries } from '@/core/gateway/browseQueryCache';
import { Button } from '@/ui/Button';
import { errorMessage } from '@/core/errorMessage';
import { ChoiceGroup } from '@/ui/ChoiceGroup';
import { ArrowLeftIcon } from '@/ui/icons';
import { OpenInEditorButton } from '@/ui/OpenInEditorButton';

interface DocumentMeta {
  title: string;
  composer: string | null;
  owned: boolean;
}

function invalidateSavedScores(): void {
  invalidateBrowseQueries('private', BROWSE_QUERY_KEYS.myScores, BROWSE_QUERY_KEYS.myDrafts);
  invalidateBrowseQueries('public', BROWSE_QUERY_KEYS.publicScores);
}

interface DocumentActionsProps {
  draftId?: string;
  savedScoreId?: string;
  onTitleChange?: (title: string) => void;
  /** the editor's toast slot: what went wrong with the document, or null to clear it */
  onNotice?: (text: string | null) => void;
}

function SavedScoreIdentity({ scoreId }: { scoreId: string }) {
  const location = useLocation();
  const score = useEditor((state) => state.savedScore);
  const loading = useEditor((state) => state.loading);
  const title = score?.id === scoreId ? score.title : loading ? 'Loading…' : 'Score unavailable';
  const returnTo =
    typeof location.state?.returnTo === 'string' && location.state.returnTo.startsWith('/') && !location.state.returnTo.startsWith('//')
      ? location.state.returnTo
      : '/explore';
  return (
    <div className="bar-identity">
      <Link to={returnTo} className="icon-btn ghost bar-back" title="Back to scores" aria-label="Back to scores">
        <ArrowLeftIcon />
      </Link>
      <span className="title" title={title}>
        <strong>{title}</strong>
      </span>
      <OpenInEditorButton scoreId={scoreId} disabled={score?.id !== scoreId} />
    </div>
  );
}

export function EditorDocumentActions(props: DocumentActionsProps) {
  return props.savedScoreId ? <SavedScoreIdentity scoreId={props.savedScoreId} /> : <DraftDocumentActions {...props} />;
}

/** A single Save action; the server owns both the working copy and durable score versions. */
function DraftDocumentActions({ draftId, onTitleChange, onNotice }: DocumentActionsProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const pendingSavedOpen = useRef(location.state?.savedDraftId === draftId && !!draftId);
  const document = useEditor((state) => state.document);
  const documentSnapshot = useMemo(() => JSON.stringify(document), [document]);
  const [savedSnapshot, setSavedSnapshot] = useState<string | null>(null);
  const saved = document.id === draftId && savedSnapshot === documentSnapshot;
  const userId = useAuthStore((state) => state.userId);
  const documentLoading = useEditor((state) => state.loading);
  const [meta, setMeta] = useState<DocumentMeta | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const active = useRef(true);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [composer, setComposer] = useState('');
  const [isPublic, setIsPublic] = useState<boolean | null>(null);
  const [createdScoreId, setCreatedScoreId] = useState<string | null>(null);
  const created = useRef<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (location.state?.savedDraftId !== draftId || !draftId) return;
    const { savedDraftId: _savedDraftId, ...rest } = location.state as Record<string, unknown>;
    // Consume the handoff once: a reload must not label subsequent edits as saved.
    navigate(
      { pathname: location.pathname, search: location.search, hash: location.hash },
      { replace: true, state: Object.keys(rest).length ? rest : null },
    );
  }, [draftId, location, navigate]);
  useEffect(() => {
    if (!pendingSavedOpen.current || documentLoading || document.id !== draftId) return;
    pendingSavedOpen.current = false;
    setSavedSnapshot(documentSnapshot);
  }, [documentLoading, document.id, draftId, documentSnapshot]);

  const report = useCallback((error: unknown) => {
    if (!active.current) return;
    if (error instanceof AuthRequiredError) useAuthPrompt.getState().open();
    else onNotice?.(errorMessage(error, 'The score could not be saved.'));
  }, [onNotice]);

  const loadMetadata = useCallback(async (): Promise<DocumentMeta> => {
    if (!draftId) throw new Error('No document is open.');
    const drafts = await libraryGateway.listMyDrafts();
    const draft = drafts.find((item) => item.id === draftId);
    if (!draft) throw new Error('This working copy could not be found.');
    const score = draft.refScoreId ? await libraryGateway.getScore(draft.refScoreId) : null;
    if (draft.refScoreId && !score) throw new Error('The original score could not be loaded.');
    if (score && !userId) throw new Error('Your account identity could not be loaded.');
    return {
      title: score?.title || draft.title || 'Untitled',
      composer: score?.composer ?? null,
      owned: Boolean(score && score.authorId === userId),
    };
  }, [draftId, userId]);

  useEffect(() => {
    let cancelled = false;
    setMetadataLoading(true);
    void loadMetadata()
      .then((result) => {
        if (!cancelled) setMeta(result);
      })
      .catch((error) => {
        if (!cancelled) report(error);
      })
      .finally(() => {
        if (!cancelled) setMetadataLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadMetadata, report]);

  useLayoutEffect(() => {
    if (meta) onTitleChange?.(meta.title);
  }, [meta, onTitleChange]);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    element.showModal();
    return () => element.close();
  }, [open]);

  const cancel = () => {
    if (busyRef.current) return;
    if (created.current) navigate('/library');
    else setOpen(false);
  };
  const save = async () => {
    if (useEditor.getState().source?.kind === 'saved' || !draftId || busyRef.current || documentLoading) return;
    busyRef.current = true;
    setBusy(true);
    onNotice?.(null);
    try {
      const details = meta ?? await loadMetadata();
      if (active.current) setMeta(details);
      if (!active.current) return;
      if (!details.owned) {
        setTitle(details.title === 'Untitled' ? '' : details.title);
        setComposer(details.composer ?? '');
        if (!created.current) setIsPublic(null);
        setSaveError(null);
        setOpen(true);
        return;
      }
      // This read joins the editor gateway's queue behind every edit already requested.
      const snapshot = await useEditor.getState().gateway.load(draftId);
      const snapshotKey = JSON.stringify(snapshot);
      if (!active.current || snapshotKey === savedSnapshot) return;
      await libraryGateway.promoteDraft(draftId);
      invalidateSavedScores();
      if (active.current) setSavedSnapshot(snapshotKey);
    } catch (error) {
      report(error);
    } finally {
      busyRef.current = false;
      if (active.current) setBusy(false);
    }
  };
  const createScore = async () => {
    if (useEditor.getState().source?.kind === 'saved' || !draftId || busyRef.current || (!created.current && !title.trim())) return;
    if (!created.current && isPublic === null) {
      setSaveError('Choose Private or Public before saving.');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setSaveError(null);
    try {
      if (!created.current) {
        await useEditor.getState().gateway.load(draftId);
        if (!active.current) return;
        const result = await libraryGateway.saveDraftAsScore(draftId, {
          title: title.trim(),
          composer: composer.trim() || null,
          isPublic: isPublic!,
        });
        created.current = result.scoreId;
        invalidateSavedScores();
        if (active.current) setCreatedScoreId(result.scoreId);
      }
      if (!active.current) return;
      const result = await libraryGateway.createDraft(created.current!);
      invalidateBrowseQueries('private', BROWSE_QUERY_KEYS.myDrafts);
      if (active.current) navigate(`/edit/${encodeURIComponent(result.draftId)}`, { replace: true, state: { savedDraftId: result.draftId } });
    } catch (error) {
      if (!active.current) return;
      if (error instanceof AuthRequiredError) {
        setOpen(false);
        useAuthPrompt.getState().open(() => {
          if (active.current) setOpen(true);
        });
        return;
      }
      setSaveError(`${created.current ? 'The score was saved, but its working copy could not be opened. ' : ''}${errorMessage(error, 'Please try again.')}`);
    } finally {
      busyRef.current = false;
      if (active.current) setBusy(false);
    }
  };

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.code !== 'KeyS') return;
      event.preventDefault();
      if (open) {
        if (!busyRef.current) form.current?.requestSubmit();
      } else void save();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  return (
    <>
      <div className="bar-identity">
        <Link to="/library" className="icon-btn ghost bar-back" title="Back to Library" aria-label="Back to Library">
          <ArrowLeftIcon />
        </Link>
        <span className="title" title={meta?.title}>
          <strong className={meta || !metadataLoading ? undefined : 'pending'}>{meta?.title || 'Untitled'}</strong>
        </span>
        <Button className="document-save" disabled={!draftId || documentLoading || metadataLoading || busy} onClick={() => void save()} title="Save (Cmd/Ctrl+S)">
          <span className="document-save-label" aria-live="polite">
            {busy ? 'Saving…' : saved && !metadataLoading && meta ? 'Saved' : 'Save'}
          </span>
        </Button>
      </div>
      {open &&
        createPortal(
          <dialog
            ref={dialog}
            className="save-score-dialog"
            aria-labelledby="save-score-title"
            onCancel={(event) => {
              event.preventDefault();
              cancel();
            }}
          >
            <form
              ref={form}
              onSubmit={(event) => {
                event.preventDefault();
                void createScore();
              }}
            >
              <h2 id="save-score-title">{createdScoreId ? 'Score saved' : 'Save score'}</h2>
              <label>
                Title
                <input
                  autoFocus
                  required
                  pattern={'.*\\S.*'}
                  title="Enter a title"
                  value={title}
                  disabled={busy || Boolean(createdScoreId)}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label>
                Composer <span className="optional">Optional</span>
                <input value={composer} disabled={busy || Boolean(createdScoreId)} onChange={(event) => setComposer(event.target.value)} />
              </label>
              <fieldset className="score-privacy" disabled={busy || Boolean(createdScoreId)}>
                <legend>Privacy</legend>
                <ChoiceGroup
                  value={isPublic === null ? null : isPublic ? 'public' : 'private'}
                  onChange={(value) => {
                    setIsPublic(value === 'public');
                    setSaveError(null);
                  }}
                  options={[
                    { value: 'private', label: 'Private' },
                    { value: 'public', label: 'Public' },
                  ]}
                  ariaLabel="Score privacy"
                  required
                />
                <p>{isPublic === null ? 'Choose who can see this score.' : isPublic ? 'Visible to everyone in Explore.' : 'Only you can see this score.'}</p>
              </fieldset>
              {saveError && (
                <p className="save-score-error" role="alert">
                  {saveError}
                </p>
              )}
              <div className="save-score-actions">
                <Button onClick={cancel} disabled={busy}>
                  {createdScoreId ? 'Back to Library' : 'Cancel'}
                </Button>
                <Button type="submit" variant="primary" disabled={busy || (!createdScoreId && (!title.trim() || isPublic === null))}>
                  {busy ? 'Saving…' : createdScoreId ? 'Open saved score' : 'Save'}
                </Button>
              </div>
            </form>
          </dialog>,
          window.document.body,
        )}
    </>
  );
}
