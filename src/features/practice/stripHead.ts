import { Renderer, Stave, StaveConnector } from 'vexflow';
import type { ClefName, KeyAlteration, Measure, ScoreDocument } from '@/core/model/score';
import { ContextIndex } from '@/core/model/contexts';
import { createKeySignature } from '@/rendering/vexflow/contextMarks';
import { STAFF_SPACE } from '@/rendering/vexflow/engravingScale';

/** What the head of a system draws for one bar: the clef and key of each staff, and the time signature. */
export interface HeadState {
  clefs: [ClefName, ClefName];
  keys: [KeyAlteration[], KeyAlteration[]];
  time: string;
}

/** The staves' x and the bottom line of each staff in the bar's system, in layout units: where the head is drawn. */
export interface HeadGeometry {
  left: number;
  trebleBottom: number;
  bassBottom: number;
  height: number;
  ink: string;
}

/** The room after the last glyph of the head, as the engraving leaves it before the first note. */
const HEAD_PAD = STAFF_SPACE;

export function timeSignatureOf(measure: Measure): string {
  const { beats, beatValue, dots = 0 } = measure.timeSignature;
  return `${beats * (2 ** (dots + 1) - 1)}/${beatValue * 2 ** dots}`;
}

export function headStateAt(doc: ScoreDocument, contexts: ContextIndex, measureIndex: number): HeadState | null {
  const measure = doc.measures[measureIndex];
  if (!measure || doc.staffOrder.length < 2) return null;
  const [upper, lower] = doc.staffOrder;
  const key = (staffId: string) => contexts.keyAt(staffId, measure.id, 0)?.alterations ?? Array<KeyAlteration>(7).fill('natural');
  return {
    clefs: [contexts.clefNameAt(upper, measure.id, 0), contexts.clefNameAt(lower, measure.id, 0)],
    keys: [key(upper), key(lower)],
    time: timeSignatureOf(measure),
  };
}

export const headKey = (state: HeadState): string => JSON.stringify(state);

/** The two staves of a head with its begin modifiers laid out the way the engraving lays out a system's first bar. */
function staves(state: HeadState, left: number, width: number, context?: Parameters<Stave['setContext']>[0]): [Stave, Stave] {
  const made = [0, 1].map(() => {
    const stave = new Stave(left, 0, width);
    if (context) stave.setContext(context);
    return stave;
  }) as [Stave, Stave];
  made.forEach((stave, i) => {
    stave.addClef(state.clefs[i]);
    stave.setClef(state.clefs[i]);
    createKeySignature(state.keys[i], state.clefs[i]).addToStave(stave);
    stave.addTimeSignature(state.time);
  });
  Stave.formatBegModifiers(made);
  return made;
}

/** Where the notes would start after this head, from the sheet's left edge. */
export function headBlockWidth(state: HeadState, left: number, context: Parameters<Stave['setContext']>[0]): number {
  const [upper, lower] = staves(state, left, 1000, context);
  return Math.max(upper.getNoteStartX(), lower.getNoteStartX()) + HEAD_PAD;
}

/** Draw the head into `host` (replacing what it held): the brace, the barline, and both staves with their clef, key and time signature.
 *  Returns the width of the block drawn, in layout units. */
export function drawHead(host: HTMLDivElement, state: HeadState, geometry: HeadGeometry): number {
  host.replaceChildren();
  const renderer = new Renderer(host, Renderer.Backends.SVG);
  const context = renderer.getContext();
  const [upper, lower] = staves(state, geometry.left, 1000, context);
  const width = Math.max(upper.getNoteStartX(), lower.getNoteStartX()) + HEAD_PAD;
  renderer.resize(width, geometry.height);
  context.setFillStyle(geometry.ink);
  context.setStrokeStyle(geometry.ink);
  // the staves stand where the bar's own staves stand: the bottom line is the line the zones are measured from
  const bottomLine = upper.getYForLine(4);
  upper.setY(geometry.trebleBottom - bottomLine);
  lower.setY(geometry.bassBottom - bottomLine);
  upper.setWidth(width - geometry.left);
  lower.setWidth(width - geometry.left);
  upper.setContext(context);
  lower.setContext(context);
  Stave.formatBegModifiers([upper, lower]);
  upper.draw();
  lower.draw();
  new StaveConnector(upper, lower).setType('brace').setContext(context).draw();
  new StaveConnector(upper, lower).setType('singleLeft').setContext(context).draw();
  return width;
}
