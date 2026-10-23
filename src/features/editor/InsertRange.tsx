import { measureBeats } from '@/core/model/contexts';
import type { InsertRange as Range, RangeSpan } from '@/core/model/insertRange';
import type { ScoreDocument } from '@/core/model/score';
import { staffOnsetX, type ScoreLayout } from '@/rendering/ScoreRenderer';

// The stretch a mark being placed will act on: a translucent band over its bars, as tall as the staves it acts on. It only paints.

interface Band { x: number; y: number; width: number; height: number }

/** the bands of one stretch, one per row of the score: neighbouring bars on a row are one band */
function bandsOf(doc: ScoreDocument, layout: ScoreLayout, span: RangeSpan): Band[] {
  const order = new Map(doc.measures.map((measure, index) => [measure.id, index]));
  const first = order.get(span.from.measureId);
  let last = order.get(span.to.measureId);
  if (first === undefined || last === undefined) return [];
  // a stop at the very start of a bar is the barline before it
  if (last > first && span.to.beats === 0) last -= 1;
  const bands: Band[] = [];
  for (let at = first; at <= last; at += 1) {
    const measure = doc.measures[at];
    const zones = layout.staffZones.filter((zone) => zone.measureId === measure.id && (span.staffIds === null || span.staffIds.includes(zone.staffId)));
    if (!zones.length) continue;
    const top = Math.min(...zones.map((zone) => zone.bottomLineY - 8 * zone.stepPx));
    const bottom = Math.max(...zones.map((zone) => zone.bottomLineY));
    const reach = zones[0].stepPx * 2;
    const left = at === first && span.from.beats > 0 ? staffOnsetX(zones[0], span.from.beats) : zones[0].left;
    const right = at === last && span.to.beats > 0 && span.to.beats < measureBeats(measure.timeSignature) ? staffOnsetX(zones[0], span.to.beats) : zones[0].x1;
    const band: Band = { x: left, y: top - reach, width: right - left, height: bottom - top + 2 * reach };
    const previous = bands[bands.length - 1];
    if (previous && previous.y === band.y && previous.height === band.height && Math.abs(previous.x + previous.width - band.x) < 1) previous.width = band.x + band.width - previous.x;
    else bands.push(band);
  }
  return bands;
}

export function InsertRange({ doc, layout, range }: { doc: ScoreDocument; layout: ScoreLayout; range: Range }) {
  return (
    <>
      {bandsOf(doc, layout, range.main).map((band, index) => <rect key={`main:${index}`} className="insert-range" x={band.x} y={band.y} width={band.width} height={band.height} rx={3} />)}
      {range.ending && bandsOf(doc, layout, range.ending).map((band, index) => <rect key={`ending:${index}`} className="insert-range ending" x={band.x} y={band.y} width={band.width} height={band.height} rx={3} />)}
    </>
  );
}
