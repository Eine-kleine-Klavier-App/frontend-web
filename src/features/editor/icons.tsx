import { useEffect, useRef } from 'react';
import type { Tool } from '@/app/store';
import {
  type DurationTool,
  isDurationTool,
  renderDurationSvg,
  getSharedGlyphBox,
} from '@/rendering/vexflow/noteGlyph';

// Duration icons are REAL VexFlow glyphs (see rendering/vexflow/noteGlyph.ts) — this guarantees
// the toolbar matches the actual score engraving pixel-for-pixel, instead of a hand-drawn
// approximation drifting out of sync with it, and shares its notehead-centered anchoring with
// the insert-ghost preview (Overlay.tsx) so both come from one mechanism. Non-duration tools
// (select/rest/tie) stay hand-drawn — they're UI symbols, not notation this app renders.

function VexDurationIcon({ duration }: { duration: DurationTool }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { svg, noteheadBox: box } = renderDurationSvg(duration, host);
    const noteheadBox = box ?? svg.getBBox();
    const cx = noteheadBox.x + noteheadBox.width / 2;
    const noteheadBottom = noteheadBox.y + noteheadBox.height;

    // one shared, measured box for every duration — this icon's own notehead center is placed
    // at its horizontal middle, and its bottom sits `above` a fixed distance up from the box
    // bottom, so all 5 icons render at the same size with their noteheads at the same spot.
    const { halfW, above, below } = getSharedGlyphBox();
    const pad = halfW * 0.15; // proportional breathing room — scales with the measured box, not a flat guess
    const left = cx - halfW - pad;
    const width = 2 * (halfW + pad);
    const top = noteheadBottom - above - pad;
    const height = above + below + pad * 2;
    svg.setAttribute('viewBox', `${left} ${top} ${width} ${height}`);

    const ICON_H = 24; // fixed render height, shared by every duration icon — sized for legibility
    // inside the 32px deck cell (was 20px/26px cell, too small to read — real user feedback)
    const scale = ICON_H / height;
    const iconW = Math.round(width * scale);
    svg.setAttribute('width', String(iconW));
    svg.setAttribute('height', String(ICON_H));
    // Renderer.resize() set an inline width (SVGContext) that otherwise wins over the
    // attributes above for layout size — override it explicitly to match the crop.
    svg.style.width = `${iconW}px`;
    svg.style.height = `${ICON_H}px`;
  }, [duration]);

  return <div className="vex-icon" ref={hostRef} />;
}

// stroke width 1.75 per DESIGN.md §9's icon spec — was 1.4/1.7/1.8, three ad-hoc per-icon values
// with no documented reason for the differences; one shared value now, applied uniformly.
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

// rendered at 24x24 — sized for legibility inside the 32px deck cell (was 20px, too small to read
// — real user feedback). viewBox stays the hand-tuned "0 0 24 24" authoring space (the select
// icon's centroid correction is calibrated to it) so only the OUTPUT size changed, not the path
// coordinate math — at 24x24 output this now also happens to be a 1:1 pixel mapping.
function svg(children: React.ReactNode) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24">
      {children}
    </svg>
  );
}

// filled, not stroked — matches `select`'s solid-triangle precedent above: a play/pause glyph's
// legibility at small (browse-card) size comes from its silhouette, not an outline.
export function PlayIcon() {
  return svg(<polygon points="7 4 20 12 7 20 7 4" fill="currentColor" />);
}
export function PauseIcon() {
  return svg(
    <>
      <rect x="7" y="4" width="4" height="16" rx="1" fill="currentColor" />
      <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" />
    </>,
  );
}
export function StopIcon() {
  return svg(<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />);
}
export function ReplayIcon() {
  return svg(
    <>
      {/* Lucide RotateCcw geometry (ISC): a continuous, balanced replay arc authored for this
          exact 24×24 stroke grid rather than a hand-spliced ellipse and arrowhead. */}
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" {...STROKE} />
      <path d="M3 3v5h5" {...STROKE} />
    </>,
  );
}

export function ExploreIcon() {
  return svg(
    <>
      <circle cx="11" cy="11" r="7" {...STROKE} />
      <path d="m21 21-4.3-4.3" {...STROKE} />
    </>,
  );
}
export function LibraryIcon() {
  return svg(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" {...STROKE} />
      <path d="M3 9h18" {...STROKE} />
    </>,
  );
}
/** Dismiss a contextual overlay/panel (PreviewPanel's close) — an "X", not a chevron: this
 *  panel goes away entirely (modal-like dismiss), unlike LeftPanel's collapse-to-a-rail (◂/▸),
 *  which stays reachable via its own reveal tab. Same `.icon-btn` treatment as the editor's
 *  toggle either way — only the glyph differs, matching what each action actually does. */
export function CloseIcon() {
  return svg(<path d="M6 6l12 12M18 6L6 18" {...STROKE} />);
}
/** Collapse a right-edge contextual panel while keeping its underlying context alive. The edge
 *  is shown as an actual panel frame; the inward arrow describes minimizing that right column
 *  without looking like Back navigation or Close's destructive X. */
export function CollapsePanelIcon() {
  return svg(
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" {...STROKE} />
      <path d="M15 4v16" {...STROKE} />
      <path d="m9 9 3 3-3 3" {...STROKE} />
    </>,
  );
}
export function BackIcon() {
  return svg(<path d="M15 5 8 12l7 7" {...STROKE} />);
}
export function SignOutIcon() {
  return svg(
    <>
      <path d="M10 5H5v14h5" {...STROKE} />
      <path d="M13 8l4 4-4 4M8 12h9" {...STROKE} />
    </>,
  );
}
export function FolderIcon() {
  return svg(<path d="M3 6.5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11Z" {...STROKE} />);
}
export function EditIcon() {
  return svg(
    <>
      <path d="M14.5 4.5 19.5 9.5 8 21H3v-5L14.5 4.5Z" {...STROKE} />
      <path d="M12.5 6.5l4 4" {...STROKE} />
    </>,
  );
}
export function PracticeIcon() {
  return svg(
    <>
      <path d="M8 20h8l-2.5-14h-3L8 20Z" {...STROKE} />
      <path d="M12 6V4" {...STROKE} />
      <path d="M12 10l3 7" {...STROKE} />
    </>,
  );
}

// a paired-eighth-notes glyph (♫) — the app's brand mark. Replaces an empty flat-color square
// that had nothing inside it (design-audit Phase 2 finding). Noteheads filled solid (same
// silhouette-over-outline logic as Play/Pause above), beam stroked.
export function BrandMark() {
  return svg(
    <>
      <circle cx="7" cy="17" r="3" fill="currentColor" />
      <circle cx="16" cy="15" r="3" fill="currentColor" />
      <path d="M10 17V6l9-2v11" {...STROKE} />
      <path d="M10 8.5 19 6.5" {...STROKE} />
    </>,
  );
}

export function ToolIcon({ id }: { id: Tool }) {
  if (isDurationTool(id)) return <VexDurationIcon duration={id} />;

  switch (id) {
    case 'select':
      // shifted +2.3 in x from the raw bbox-centered coordinates: the cursor's visible "weight"
      // is its solid triangular head, not the thin tail, so the AREA-weighted centroid (not the
      // bbox center) needs to land on-center. Vertical needed no correction.
      return svg(
        <path d="M8.3 4 L8.3 18 L12 14 L14.6 20 L16.6 19 L13.9 13.2 L18.8 13 Z" fill="currentColor" />,
      );
    case 'rest':
      return svg(
        <path
          d="M9 5 L12.6 9 L9.9 11.4 C8.5 12.6 9.7 13.8 11.8 14.4 C9.6 14.5 8.3 15.7 10.4 18.2"
          {...STROKE}
        />,
      );
    case 'tie':
      return svg(<path d="M5.5 11 Q12 17.5 18.5 11" {...STROKE} />);
    default:
      return null;
  }
}
