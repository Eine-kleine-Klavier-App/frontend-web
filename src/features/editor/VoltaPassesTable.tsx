import { useEffect, useRef, useState } from 'react';
import type { VoltaContext } from '@/core/model/score';
import { MinusIcon, PlusIcon } from '@/ui/icons';

// The passes of a volta in one table: the passes across, the endings down, one dot in a column. A pass is given to an ending by pressing its
// cell or by dragging the dot to another row of the same column. The first pass is the first ending's; an ending keeps at least one pass;
// the last pass is the last ending's, worked out. «−» and «+» in the header change how many times it is played; the last row adds an ending.

export function VoltaPassesTable({ context, busy, canAdd, onSetPasses, onTimes, onAddEnding }: {
  context: VoltaContext;
  busy: boolean;
  canAdd: boolean;
  /** the passes of an ending (counted from zero), all of them */
  onSetPasses: (fragment: number, passes: number[]) => void;
  onTimes: (times: number) => void;
  onAddEnding: () => void;
}) {
  const passes = Array.from({ length: context.passCount }, (_, offset) => offset + 1);
  const stored = context.passCount - 1;
  const [drag, setDrag] = useState<{ pass: number; from: number; over: number | null } | null>(null);
  /** where a pass was just put, until the change comes back: the dot stays there instead of jumping back first */
  const [held, setHeld] = useState<{ pass: number; row: number } | null>(null);
  const dragged = useRef(false);
  useEffect(() => { if (!busy) setHeld(null); }, [busy, context]);
  const ownerOf = (pass: number): number => context.fragments.findIndex((fragment) => fragment.passes.includes(pass));
  /** why the pass cannot be put in the ending, or null when it can: the backend's rules, so a move that would be refused is not offered */
  const refusal = (pass: number, index: number): string | null => {
    const owner = ownerOf(pass);
    if (pass === 1) return 'The first pass belongs to the first ending.';
    if (pass > stored || owner < 0) return 'The last pass belongs to the last ending.';
    if (index === owner) return null;
    const after = context.fragments.map((fragment) => new Set(fragment.passes));
    after[owner].delete(pass);
    after[index].add(pass);
    if (after.some((passes) => passes.size === 0)) return 'An ending is played in at least one pass.';
    const firsts = after.map((passes) => Math.min(...passes));
    if (firsts.some((first, at) => at > 0 && first <= firsts[at - 1])) return 'An ending is first played after the one before it.';
    return null;
  };
  /** a pass can be dragged when some ending other than its own would take it */
  const movable = (pass: number): boolean => context.fragments.some((_, index) => index !== ownerOf(pass) && refusal(pass, index) === null);
  /** the pass goes to the ending: to the first by taking it off the one that has it, to another by adding it to that one */
  const assign = (index: number, pass: number) => {
    const owner = ownerOf(pass);
    if (index === owner) return;
    setHeld({ pass, row: index });
    if (index === 0) onSetPasses(owner, context.fragments[owner].passes.filter((other) => other !== pass));
    else onSetPasses(index, [...context.fragments[index].passes, pass]);
  };
  const endings = context.fragments.length;
  /** the row a pass's dot stands in: the dragged one follows the pointer, a just-moved one stays, the last pass is the last ending's */
  const rowOf = (pass: number): number => {
    if (drag && drag.pass === pass) return drag.over ?? drag.from;
    if (held && held.pass === pass) return held.row;
    return pass === context.passCount ? endings : ownerOf(pass);
  };
  const begin = (event: React.PointerEvent, pass: number, from: number) => {
    if (busy || event.button !== 0 || !movable(pass)) return;
    const origin = { x: event.clientX, y: event.clientY };
    let moved = false;
    const cursor = document.body.style.cursor;
    const find = (at: PointerEvent): number | null => {
      const cell = document.elementFromPoint(at.clientX, at.clientY)?.closest<HTMLElement>('[data-pass-cell]');
      return cell && !(cell as HTMLButtonElement).disabled && Number(cell.dataset.pass) === pass ? Number(cell.dataset.ending) : null;
    };
    const move = (at: PointerEvent): void => {
      if (!moved && Math.hypot(at.clientX - origin.x, at.clientY - origin.y) < 4) return;
      if (!moved) document.body.style.cursor = 'grabbing';
      moved = true;
      setDrag({ pass, from, over: find(at) });
    };
    const end = (at: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      document.body.style.cursor = cursor;
      const to = moved ? find(at) : null;
      setDrag(null);
      if (!moved) return;
      dragged.current = true;
      if (to !== null && to !== from) assign(to, pass);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };
  const cell = (index: number, pass: number) => {
    const owner = ownerOf(pass);
    const on = owner === index;
    const blocked = on ? !movable(pass) : refusal(pass, index) !== null;
    const why = on ? context.fragments.map((_, other) => (other === index ? null : refusal(pass, other))).find((reason) => reason !== null) : refusal(pass, index);
    const title = drag || !blocked ? undefined : why ?? undefined;
    const over = drag?.pass === pass && drag.over === index && drag.from !== index;
    return (
      <button key={`${index}:${pass}`} type="button" data-pass-cell data-pass={pass} data-ending={index}
        style={{ gridRow: 3 + index, gridColumn: pass + 1 }}
        className={'passes-cell' + (on ? ' on' : '') + (blocked ? ' blocked' : '') + (rowOf(pass) === index ? ' has' : '') + (over ? ' drop' : '')}
        aria-pressed={on} aria-label={`Pass ${pass} in ending ${index + 1}`} disabled={blocked} title={title}
        onPointerDown={(event) => begin(event, pass, index)}
        onClick={() => {
          if (dragged.current) { dragged.current = false; return; }
          if (busy) return;
          // the first ending's own dot is only dragged away: a pass it gives up has to go to a chosen ending
          if (on && index === 0) return;
          assign(on ? 0 : index, pass);
        }} />
    );
  };
  return (
    <div className="passes-table" role="group" aria-label="Which ending plays each pass" onPointerDownCapture={() => { dragged.current = false; }} style={{ gridTemplateColumns: `max-content repeat(${context.passCount}, minmax(0, 1fr))` }}>
      <div className="passes-top" style={{ gridRow: 1 }}>
        <span>Times played</span>
        <span className="passes-stepper">
          <button type="button" className="icon-btn ghost" aria-label="Fewer passes" disabled={context.passCount <= 2} onClick={() => { if (!busy) onTimes(context.passCount - 1); }}><MinusIcon /></button>
          <b>{context.passCount}</b>
          <button type="button" className="icon-btn ghost" aria-label="More passes" onClick={() => { if (!busy) onTimes(context.passCount + 1); }}><PlusIcon /></button>
        </span>
      </div>
      {passes.map((pass) => <span className={'passes-head' + (pass === context.passCount ? ' last' : '')} style={{ gridRow: 2, gridColumn: pass + 1 }} key={pass}>{pass}</span>)}
      {context.fragments.map((_, index) => (
        <span className="passes-name" style={{ gridRow: 3 + index, gridColumn: 1 }} key={index}>Ending {index + 1}</span>
      ))}
      <span className="passes-name passes-last" style={{ gridRow: 3 + endings, gridColumn: 1 }}>Last ending</span>
      {context.fragments.flatMap((_, index) => passes.map((pass) => cell(index, pass)))}
      {passes.map((pass) => <span className={'passes-cell passes-fixed blocked' + (rowOf(pass) === endings ? ' has' : '')} style={{ gridRow: 3 + endings, gridColumn: pass + 1 }} key={`last:${pass}`} />)}
      {passes.map((pass) => (
        <span key={`dot:${pass}`} className={'passes-token' + (movable(pass) ? '' : ' locked')} style={{ gridRow: 3, gridColumn: pass + 1, ['--row' as string]: rowOf(pass) }}>
          <span className="passes-dot" />
        </span>
      ))}
      <button type="button" className="passes-add" style={{ gridRow: 4 + endings }} disabled={!canAdd} onClick={() => { if (!busy) onAddEnding(); }}><PlusIcon />Add ending</button>
    </div>
  );
}
