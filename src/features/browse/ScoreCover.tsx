import { useMemo } from 'react';
import type { ScoreDocument } from '@/core/model/score';
import { PreviewPlayButton } from './PreviewPlayButton';
import { plateTintClass } from './plateTint';
import { getGlyphMarkup } from '@/rendering/vexflow/clefGlyph';

/** Anything that can wear a cover — a score, draft, practice item, or branch. */
export interface Coverable {
  id: string;
  title: string;
  composer?: string | null;
  coverImageUrl: string | null;
  previewDocument: ScoreDocument | null;
}

/** A publisher's-colophon cover: a warm, composer-tinted ground with one real engraved glyph
 *  (VexFlow/Bravura — DESIGN.md mandates a true engraving font for music glyphs, never hand-drawn
 *  SVG). Identity comes from the tint + the title/composer rendered by the card body, so a
 *  user-supplied cover image drops straight into this slot with nothing baked in. Holds NO title text.
 *
 *  Interactive play sits ON the cover, so callers wrap it in a div[role=button], never a
 *  <button>. `playable=false` drops the button (work-card thumbs). */
export function ScoreCover({ score, playable = true }: { score: Coverable; playable?: boolean }) {
  const hasImage = !!score.coverImageUrl;
  const glyph = useMemo(() => (hasImage ? null : getGlyphMarkup('gClef')), [hasImage]);
  return (
    <div className={'score-cover ' + (hasImage ? 'has-image' : plateTintClass(score.composer ?? score.title))}>
      <div className="score-cover-art">
        {hasImage ? (
          <img className="score-cover-image" src={score.coverImageUrl!} alt={score.title} />
        ) : (
          glyph && (
            <svg
              className="score-colophon"
              viewBox={glyph.viewBox}
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: glyph.markup }}
            />
          )
        )}
      </div>
      {playable && <PreviewPlayButton score={score} size="sm" className="score-cover-play" />}
    </div>
  );
}
