import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/core/auth/authStore';
import { AuthRequiredError } from '@/core/auth/authorizedFetch';
import { requireAuth, useAuthPrompt } from '@/core/auth/authPrompt';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import { BROWSE_QUERY_KEYS, invalidateBrowseQueries } from '@/core/gateway/browseQueryCache';
import { errorMessage } from '@/core/errorMessage';
import { Button } from '@/ui/Button';
import { CloseIcon } from '@/ui/icons';

/** The explicit write entry of the preview panel: a saved score is opened for editing only from there. */
export function OpenInEditorButton({ scoreId, disabled = false, active = true }: { scoreId: string; disabled?: boolean; active?: boolean }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  const generation = useRef(0);

  useLayoutEffect(() => {
    generation.current++;
    locked.current = false;
    setBusy(false);
    setError(null);
    return () => {
      generation.current++;
    };
  }, [scoreId, active]);

  const open = () => {
    if (!active || disabled || locked.current) return;
    const current = generation.current;
    const create = async () => {
      if (current !== generation.current || locked.current) return;
      const actor = useAuthStore.getState().userId;
      locked.current = true;
      setBusy(true);
      setError(null);
      try {
        const draft = await libraryGateway.createDraft(scoreId);
        invalidateBrowseQueries('private', BROWSE_QUERY_KEYS.myDrafts);
        if (current === generation.current && actor === useAuthStore.getState().userId) navigate(`/edit/${encodeURIComponent(draft.draftId)}`);
      } catch (cause) {
        if (current !== generation.current) return;
        if (cause instanceof AuthRequiredError) useAuthPrompt.getState().open(() => void create());
        else setError(errorMessage(cause, 'The working copy could not be created.'));
      } finally {
        if (current === generation.current) {
          locked.current = false;
          setBusy(false);
        }
      }
    };
    requireAuth(() => void create());
  };

  return (
    <>
      <Button variant="secondary" className="document-open-editor" disabled={disabled || busy} onClick={open}>
        {busy ? 'Opening…' : 'Open in editor'}
      </Button>
      {error &&
        createPortal(
          <div className="document-action-notice" role="alert">
            <span>{error}</span>
            <button type="button" className="icon-btn ghost" aria-label="Dismiss error" onClick={() => setError(null)}>
              <CloseIcon />
            </button>
          </div>,
          window.document.body,
        )}
    </>
  );
}
