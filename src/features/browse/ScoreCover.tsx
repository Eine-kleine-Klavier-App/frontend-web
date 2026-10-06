import { useMemo } from 'react';
import { plateTintClass } from './plateTint';
import { getGlyphMarkup } from '@/rendering/vexflow/clefGlyph';

export interface Coverable {
  id: string;
  title: string;
  composer?: string | null;
}

/** Decorative catalog cover until the API supports uploaded cover art. */
export function ScoreCover({ score }: { score: Coverable }) {
  const glyph = useMemo(() => getGlyphMarkup('gClef'), []);
  return (
    <div className={'score-cover ' + plateTintClass(score.composer ?? score.title)}>
      <div className="score-cover-art">
        {glyph && <svg className="score-colophon" viewBox={glyph.viewBox} preserveAspectRatio="xMidYMid meet"
          aria-hidden="true" dangerouslySetInnerHTML={{ __html: glyph.markup }} />}
      </div>
    </div>
  );
}
