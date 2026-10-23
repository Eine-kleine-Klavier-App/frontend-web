import { useEffect, useRef, useState } from 'react';
import { useEditor } from '@/app/store';
import type { Command } from '@/core/commands/command';
import type { Fraction, ScoreContext, ScoreDocument } from '@/core/model/score';
import type { ScoreLayout } from '@/rendering/ScoreRenderer';
import { measureBeats } from '@/core/model/contexts';
import type { RangeSpan } from '@/core/model/insertRange';
import { REPEAT_SIGN_ROOM, STAFF_SPACE } from '@/rendering/vexflow/engravingScale';
import { HandleMark } from './HandleMark';
import { InsertRange } from './InsertRange';

// The handles on the boundaries of a selected repeat or volta. Their boundaries stand on measure lines only, so a barline is a number:
// `b` is the line before measure `b`, and the number of measures is the end of the score. A handle is dragged to another barline (the
// dotted line shows which) and sends the command that moves that boundary; what the move does to the parts around it, and whether it is
// allowed, is the backend's.

interface Place { measureId: string; position: Fraction }

const ZERO: Fraction = { numerator: 0, denominator: 1 };

interface Handle {
  key: string;
  label: string;
  /** the barline it stands on now */
  at: number;
  /** the barlines it may be dragged to, both included */
  min: number;
  max: number;
  /** where it is drawn: a start on the left of its measure, an end on the right of the one before */
  side: 'start' | 'end';
  move: (to: Place | null) => Command;
}

/** a barline as drawn: where it stands and how tall it is, at each place it is drawn (a barline between two systems is drawn at the end of
 *  one and the start of the next) */
/** `signX`: where a repeat sign stands when the measure begins a row, after the clef, key and time signature */
interface Spot { x: number; top: number; bottom: number; step: number; signX?: number }

const barlineOf = (doc: ScoreDocument, measureId: string | null): number =>
  measureId === null ? doc.measures.length : Math.max(0, doc.measures.findIndex((measure) => measure.id === measureId));

const placeAt = (doc: ScoreDocument, barline: number): Place | null =>
  barline >= doc.measures.length ? null : { measureId: doc.measures[barline].id, position: ZERO };

function handlesOf(doc: ScoreDocument, context: ScoreContext): Handle[] {
  const measures = doc.measures.length;
  if (context.kind === 'refrain') {
    const start = barlineOf(doc, context.measureId);
    const end = barlineOf(doc, context.endMeasureId);
    return [
      { key: 'start', label: 'Move repeat start', at: start, min: 0, max: end - 1, side: 'start',
        move: (to) => ({ type: 'moveRefrainStart', refrainId: context.id, start: to! }) },
      { key: 'end', label: 'Move repeat end', at: end, min: start + 1, max: measures, side: 'end',
        move: (to) => ({ type: 'moveRefrainEnd', refrainId: context.id, end: to }) },
    ];
  }
  if (context.kind === 'volta') {
    const start = barlineOf(doc, context.measureId);
    const bodyEnd = barlineOf(doc, context.bodyEndMeasureId);
    const ends = context.fragments.map((fragment) => barlineOf(doc, fragment.endMeasureId));
    return [
      { key: 'start', label: 'Move start of the body', at: start, min: 0, max: bodyEnd - 1, side: 'start',
        move: (to) => ({ type: 'moveVoltaStart', voltaId: context.id, start: to! }) },
      { key: 'boundary-0', label: 'Move end of the body', at: bodyEnd, min: start + 1, max: measures, side: 'end',
        move: (to) => ({ type: 'moveVoltaBoundary', voltaId: context.id, boundary: 0, to }) },
      ...ends.map((at, index): Handle => ({
        key: `boundary-${index + 1}`, label: `Move end of ending ${index + 1}`, at, side: 'end',
        // the end of the last ending moves alone, never past the one before it
        min: (index === ends.length - 1 ? (ends[index - 1] ?? bodyEnd) : start) + 1, max: measures,
        move: (to) => ({ type: 'moveVoltaBoundary', voltaId: context.id, boundary: index + 1, to }),
      })),
    ];
  }
  return [];
}

export function BoundaryHandles({ layout, toSvg, enabled }: {
  layout: ScoreLayout;
  toSvg: (event: { clientX: number; clientY: number }) => { x: number; y: number };
  enabled: boolean;
}) {
  const doc = useEditor((s) => s.document);
  const dispatch = useEditor((s) => s.dispatch);
  const selectedStructureIds = useEditor((s) => s.selectedStructureIds);
  const [drag, setDrag] = useState<{ handle: Handle; to: number; context: ScoreContext } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  /** the drawn extent of the barlines before measure `b`: the end of the measure before it, and the start of its own row when it begins one */
  const spots = (barline: number): Spot[] => {
    const rect = (index: number) => {
      const zones = layout.staffZones.filter((zone) => zone.measureId === doc.measures[index]?.id);
      const first = zones.find((zone) => zone.staffId === doc.staffOrder[0]);
      const last = zones.find((zone) => zone.staffId === doc.staffOrder[doc.staffOrder.length - 1]);
      return first && last ? { left: first.left, signX: first.x0 - REPEAT_SIGN_ROOM + 0.9 * STAFF_SPACE, right: first.x1, top: first.bottomLineY - 8 * first.stepPx, bottom: last.bottomLineY, step: first.stepPx } : null;
    };
    const before = barline > 0 ? rect(barline - 1) : null;
    const own = barline < doc.measures.length ? rect(barline) : null;
    const out: Spot[] = [];
    if (before) out.push({ x: before.right, top: before.top, bottom: before.bottom, step: before.step });
    if (own && (!before || before.top !== own.top)) out.push({ x: own.left, signX: own.signX, top: own.top, bottom: own.bottom, step: own.step });
    return out;
  };
  const spotFor = (handle: Handle): Spot | null => {
    const found = spots(handle.at);
    const spot = (handle.side === 'start' ? found[found.length - 1] : found[0]) ?? null;
    // a start that begins a row stands on its `|:`, not on the row's left edge
    return spot && handle.side === 'start' && spot.signX !== undefined ? { ...spot, x: spot.signX } : spot;
  };
  /** the barline nearest the pointer among those the handle may go to */
  const nearest = (handle: Handle, point: { x: number; y: number }): number => {
    let best = handle.at;
    let bestDistance = Infinity;
    for (let barline = handle.min; barline <= handle.max; barline += 1) {
      for (const spot of spots(barline)) {
        const dy = point.y < spot.top ? spot.top - point.y : point.y > spot.bottom ? point.y - spot.bottom : 0;
        const distance = Math.hypot(spot.x - point.x, dy);
        if (distance < bestDistance) { best = barline; bestDistance = distance; }
      }
    }
    return best;
  };
  const guideSpot = (handle: Handle, barline: number, point: { x: number; y: number }): Spot | null =>
    spots(barline).reduce<Spot | null>((best, spot) => !best || Math.abs(spot.top - point.y) < Math.abs(best.top - point.y) ? spot : best, null) ?? spotFor(handle);

  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);
  /** a drag starts at the pointer going down: the listeners and the place it is at stand at once, not after the next render, so a quick
   *  drag is not lost */
  const begin = (handle: Handle, context: ScoreContext): void => {
    stopDrag.current?.();
    dragRef.current = { handle, to: handle.at, context };
    setDrag(dragRef.current);
    const end = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      stopDrag.current = null;
      dragRef.current = null;
      setDrag(null);
      setPointer(null);
    };
    const move = (event: PointerEvent): void => {
      const current = dragRef.current;
      if (!current) return;
      const point = toSvg(event);
      setPointer(point);
      dragRef.current = { handle: current.handle, to: nearest(current.handle, point), context: current.context };
      setDrag(dragRef.current);
    };
    const up = (): void => {
      const current = dragRef.current;
      end();
      if (current && current.to !== current.handle.at) void dispatch(current.handle.move(placeAt(doc, current.to)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    stopDrag.current = end;
  };

  if (!enabled) return null;
  const selected = doc.contexts.filter((context) => selectedStructureIds.includes(context.id) && (context.kind === 'refrain' || context.kind === 'volta'));
  const guide = drag && pointer ? guideSpot(drag.handle, drag.to, pointer) : null;
  /** the bars the repeat or volta would cover with the dragged boundary where it is now, over the whole height */
  const dragged: RangeSpan | null = (() => {
    if (!drag) return null;
    const { context, handle, to } = drag;
    const last = doc.measures[doc.measures.length - 1];
    const at = (barline: number) => (barline >= doc.measures.length ? { measureId: last?.id ?? '', beats: last ? measureBeats(last.timeSignature) : 0 } : { measureId: doc.measures[barline].id, beats: 0 });
    if (context.kind === 'refrain') {
      return { staffIds: null, from: at(handle.key === 'start' ? to : barlineOf(doc, context.measureId)), to: at(handle.key === 'end' ? to : barlineOf(doc, context.endMeasureId)) };
    }
    if (context.kind === 'volta') {
      const ends = context.fragments.map((fragment) => barlineOf(doc, fragment.endMeasureId));
      const moved = handle.key.startsWith('boundary-') ? Number(handle.key.slice(9)) : -1;
      if (moved >= 1) ends[moved - 1] = to;
      return { staffIds: null, from: at(handle.key === 'start' ? to : barlineOf(doc, context.measureId)), to: at(moved === 0 ? Math.max(to, ends[ends.length - 1]) : ends[ends.length - 1]) };
    }
    return null;
  })();
  return (
    <>
      {selected.flatMap((context) => handlesOf(doc, context).map((handle) => {
        const spot = spotFor(handle);
        if (!spot) return null;
        const step = spot.step;
        return (
          <g key={`${context.id}:${handle.key}`} className="context-endpoint" role="button" tabIndex={0} aria-label={handle.label}
            transform={`translate(${spot.x} ${spot.top - 2 * step})`}
            onPointerDown={(event) => { event.stopPropagation(); event.preventDefault(); begin(handle, context); }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              event.stopPropagation();
              const to = handle.at + (event.key === 'ArrowLeft' ? -1 : 1);
              if (to >= handle.min && to <= handle.max) void dispatch(handle.move(placeAt(doc, to)));
            }}
            onClick={(event) => event.stopPropagation()}>
            <circle className="context-endpoint-hit" r={step * 2.2} />
            <HandleMark role="span" className="context-endpoint-dot" x={0} y={0} size={step * 0.8} />
          </g>
        );
      }))}
      {dragged && drag && drag.to !== drag.handle.at && <g className="mark-guide" aria-hidden="true"><InsertRange doc={doc} layout={layout} range={{ main: dragged }} /></g>}
      {guide && drag && drag.to !== drag.handle.at && (
        <line className="context-drop-guide" x1={guide.x} x2={guide.x} y1={guide.top} y2={guide.bottom} />
      )}
    </>
  );
}
