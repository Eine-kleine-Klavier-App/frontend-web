import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { libraryGateway } from '@/core/gateway/defaultLibraryGateway';
import type { ScoreSummary } from '@/core/gateway/LibraryGateway';
import { ScoreThumbnail } from './ScoreThumbnail';
import { DETAIL_COVER_THUMB } from './thumbnailSizes';
import { previewPlayer, usePreviewPlayingId } from '@/core/audio/PreviewPlayer';
import { scoreToEvents } from '@/core/audio/scoreToEvents';
import { BackIcon, EditIcon, PauseIcon, PlayIcon, PracticeIcon } from '@/features/editor/icons';

/** The page a score card/row lands on now, instead of immediately branching a draft — Spotify's
 *  album page / flowkey's song page: one bigger look at the piece, then an explicit choice of
 *  what to do with it (play a preview here, practice — not built yet, or edit). Reached from
 *  both Explore and Library, so it doesn't assume which one sent you here; browser back returns
 *  to whichever it was. */
export default function ScoreDetailScreen() {
  const { scoreId } = useParams<{ scoreId: string }>();
  const navigate = useNavigate();
  const [score, setScore] = useState<ScoreSummary | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const playingId = usePreviewPlayingId();

  useEffect(() => {
    if (!scoreId) return;
    let cancelled = false;
    setScore(undefined);
    void libraryGateway.getScore(scoreId).then((r) => !cancelled && setScore(r));
    return () => {
      cancelled = true;
    };
  }, [scoreId]);

  const isPlaying = score != null && playingId === score.id;

  const togglePlay = () => {
    if (!score?.previewDocument) return;
    void previewPlayer.play(score.id, scoreToEvents(score.previewDocument));
  };

  const edit = async () => {
    if (!score || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { draftId } = await libraryGateway.createDraft(score.id);
      navigate(`/edit/${draftId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create a draft.');
    } finally {
      setBusy(false);
    }
  };

  if (score === undefined) {
    return (
      <div className="score-detail-screen">
        <div className="library-loading">Loading…</div>
      </div>
    );
  }

  if (score === null) {
    return (
      <div className="score-detail-screen">
        <button type="button" className="back-link score-detail-back" onClick={() => navigate(-1)}>
          <BackIcon />
          Back
        </button>
        <div className="library-empty">Score not found.</div>
      </div>
    );
  }

  return (
    <div className="score-detail-screen">
      <button type="button" className="back-link score-detail-back" onClick={() => navigate(-1)}>
        <BackIcon />
        Back
      </button>

      {error && <div className="library-error">{error}</div>}

      <div className="score-detail-hero">
        <ScoreThumbnail
          id={score.id}
          coverImageUrl={score.coverImageUrl}
          previewDocument={score.previewDocument}
          alt={score.title}
          width={DETAIL_COVER_THUMB.width}
          height={DETAIL_COVER_THUMB.height}
        />
        <div className="score-detail-info">
          <span className="score-detail-eyebrow">{score.isPublic ? 'Public score' : 'Private score'}</span>
          <h1 className="score-detail-title">{score.title}</h1>
          <span className="score-detail-composer">{score.composer ?? 'Unknown composer'}</span>

          <div className="score-detail-actions">
            <button
              type="button"
              className="score-detail-action primary"
              onClick={togglePlay}
              disabled={!score.previewDocument}
            >
              {isPlaying ? <PauseIcon /> : <PlayIcon />}
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <button type="button" className="score-detail-action" disabled title="Coming soon">
              <PracticeIcon />
              Practice
            </button>
            <button type="button" className="score-detail-action" disabled={busy} onClick={() => void edit()}>
              <EditIcon />
              Edit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
