import { useEffect, useRef, useState } from 'react';
import type { ScoreDocument } from '@/core/model/score';
import type { ScoreLayout } from '@/rendering/ScoreRenderer';
import { VexflowRenderer } from '@/rendering/vexflow/VexflowRenderer';

interface Props {
  /** Score or draft id — carried for a stable React key upstream; not rendered here. */
  id: string;
  /** A set cover image wins outright — the notation preview only renders when this is null.
   *  This is where a user-set cover image will go once that feature exists; until then the
   *  notation excerpt is the placeholder (on a plain neutral field — no per-item tint). */
  coverImageUrl: string | null;
  /** A pre-sliced few-measure `ScoreDocument` (see `LibraryGateway`'s DTOs) — read-only. */
  previewDocument: ScoreDocument | null;
  alt: string;
  /** Fixed target box in px. Ignored when `fill` is set (then the box is measured from the
   *  container so the cover can flex with a fluid grid column — Spotify/MuseScore-style). */
  width?: number;
  height?: number;
  /** Fluid mode: the cover fills its container completely (`width/height: 100%`) — the parent
   *  (a mosaic tile, of any aspect ratio) sets the size, and the notation is fit-scaled to the
   *  measured box. Used by the Explore mosaic where tiles vary in size. */
  fill?: boolean;
}

const NO_IDS: string[] = [];
const NO_OVERRIDES = {};

export function ScoreThumbnail({ id, coverImageUrl, previewDocument, alt, width, height, fill }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  // fluid mode: track the container's rendered size (any aspect ratio — set by the tile).
  useEffect(() => {
    if (!fill || !boxRef.current) return;
    const el = boxRef.current;
    const ro = new ResizeObserver(([entry]) =>
      setBox({ w: entry.contentRect.width, h: entry.contentRect.height }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [fill]);

  const w = fill ? box.w : (width ?? 0);
  const h = fill ? box.h : (height ?? 0);
  const fillStyle = fill ? undefined : { width: w, height: h };
  const cls = 'score-thumbnail' + (fill ? ' score-thumbnail--fill' : '');

  if (coverImageUrl) {
    return <img className={cls + ' score-thumbnail-image'} style={fillStyle} src={coverImageUrl} alt={alt} />;
  }

  const empty = !previewDocument || previewDocument.measures.length === 0;
  const ready = w > 0 && h > 0;

  return (
    <div ref={boxRef} className={cls + (empty ? ' score-thumbnail-empty' : ' score-thumbnail-notation')} style={fillStyle} aria-label={alt}>
      {!empty && ready && <Notation document={previewDocument!} boxW={w} boxH={h} />}
    </div>
  );
}

function Notation({ document, boxW, boxH }: { document: ScoreDocument; boxW: number; boxH: number }) {
  const [layout, setLayout] = useState<ScoreLayout | null>(null);
  // fit into a slightly inset box so the notation never touches the tile edges (breathing room,
  // proportional so a 48px row cover and a 300px tile both look right); still centered in the full box.
  const pad = Math.min(boxW, boxH) * 0.08;
  const innerW = Math.max(0, boxW - pad * 2);
  const innerH = Math.max(0, boxH - pad * 2);
  const scale = layout ? Math.min(1, innerW / layout.width, innerH / layout.height) : 0;
  const offsetX = layout ? Math.max(0, (boxW - layout.width * scale) / 2) : 0;
  const offsetY = layout ? Math.max(0, (boxH - layout.height * scale) / 2) : 0;
  return (
    <div
      style={{
        transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`,
        transformOrigin: 'top left',
        opacity: layout ? 1 : 0,
      }}
    >
      <VexflowRenderer
        document={document}
        selectedIds={NO_IDS}
        carrierSelectedIds={NO_IDS}
        mode="line"
        onLayout={setLayout}
        voiceColors={NO_OVERRIDES}
        stemOverrides={NO_OVERRIDES}
        hoveredNoteIds={NO_IDS}
      />
    </div>
  );
}
