import { useId, useState } from 'react';
import { useEditor, hotbarSlotKey } from '@/app/store';
import { parseMark, markLabel } from '@/core/model/markTools';
import { toolLabel, parseTool } from '@/core/model/insertItems';
import { ToolIcon } from './icons';
import { ChoiceThumb } from '@/ui/ChoiceGroup';

/** the drag payload type for an insert item (from the hot panel's library or constructor) */
export const INSERT_DRAG_TYPE = 'application/x-klavier-tool';

// The tools: in the rail (wide) the hotbar H2 — a full-width "Select · V" row above an even 5×2 grid
// of square slot cells; as the floating tray (≤64em) the same controls in one row. The chosen
// option is the raised keycap thumb (`ChoiceThumb`, the same primitive every single-choice set
// uses). Staff and voice live in the strip above the sheet (ContextStrip). An empty slot is just
// its digit. A slot is filled three ways: drag an element from the hot panel onto it, click an
// empty one (it takes what is armed), or press ⌥ + its digit (EditorScreen).
//
// Cursor/select tool has its own fixed hotkey (V, matching Figma/Illustrator convention) — not
// Escape, which the browser reserves for exiting Fullscreen API mode unblockably. Not one of the
// ten numbered hotbar slots either: it's always the same tool in the same place, nothing to
// fill/rearrange. The ten slots after it are the pinned items (digits 1-9, 0), stored in the
// browser.
export function Toolbar({ layout }: { layout: 'rail' | 'tray' }) {
  const inRail = layout === 'rail';
  const tool = useEditor((s) => s.tool);
  const activeSlot = useEditor((s) => s.activeSlot);
  const locked = useEditor((s) => s.locked);
  const setTool = useEditor((s) => s.setTool);
  const hotbarSlots = useEditor((s) => s.hotbarSlots);

  const setHotbarSlot = useEditor((s) => s.setHotbarSlot);
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const toolGroupId = useId();
  // what a click on an empty slot pins: the element that is armed now
  const pinnable = tool !== 'select' && !!(parseTool(tool) || parseMark(tool));
  const armedName = parseMark(tool) ? markLabel(parseMark(tool)!) : toolLabel(tool);

  return (
    // rail (wide): labelled sections at the top of the editor rail, nothing floats over the sheet ·
    // tray (≤1024px): the one floating tray at the bottom
    <div className={'dock' + (inRail ? ' dock--rail' : '') + (locked ? ' is-locked' : '')} {...(inRail ? {} : { 'data-occludes-canvas': true })}>
      {inRail && <span className="rail-label">Tools</span>}
      <div className={'dock-group dock-tools' + (inRail ? ' keycap-grid' : '')} role="group" aria-label="Notation tools">
        <button
          type="button"
          className={'tool tool-select' + (tool === 'select' ? ' active' : '')}
          title="Select (V)"
          aria-label="Select" aria-pressed={tool === 'select'}
          aria-disabled={locked}
          onClick={() => setTool('select')}
        >
          {tool === 'select' && <ChoiceThumb groupId={toolGroupId} />}
          <ToolIcon id="select" />
          <span className="tool-hotkey">V</span>
        </button>

        <span className="dock-sep" aria-hidden="true" />

        {hotbarSlots.map((slotTool, i) => {
          // by index, not by item: the same item pinned to two slots is two slots
          const active = !!slotTool && activeSlot === i && tool === slotTool;
          return (
            <button
              key={i}
              type="button"
              className={
                'tool' +
                (active ? ' active' : '') +
                (slotTool ? '' : ' empty') +
                (dropSlot === i ? ' drop-target' : '')
              }
              title={slotTool ? `${(parseMark(slotTool) ? markLabel(parseMark(slotTool)!) : toolLabel(slotTool))} (${hotbarSlotKey(i)})` : pinnable ? `Pin ${armedName} here (${hotbarSlotKey(i)})` : `Empty slot (${hotbarSlotKey(i)}) — drag an element here`}
              aria-label={slotTool ? (parseMark(slotTool) ? markLabel(parseMark(slotTool)!) : toolLabel(slotTool)) : pinnable ? `Pin ${armedName} to slot ${hotbarSlotKey(i)}` : `Empty slot ${hotbarSlotKey(i)}`}
              aria-pressed={active}
              // not `disabled`: a disabled button receives no drag events, and empty slots are
              // exactly where things get dropped
              aria-disabled={slotTool ? locked : !pinnable}
              onClick={() => (slotTool ? setTool(slotTool, i) : pinnable && setHotbarSlot(i, tool))}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(INSERT_DRAG_TYPE)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                if (dropSlot !== i) setDropSlot(i);
              }}
              onDragLeave={() => setDropSlot((d) => (d === i ? null : d))}
              onDrop={(e) => {
                const id = e.dataTransfer.getData(INSERT_DRAG_TYPE);
                setDropSlot(null);
                if (!id || (!parseTool(id) && !parseMark(id))) return;
                e.preventDefault();
                setHotbarSlot(i, id);
              }}
            >
              {active && <ChoiceThumb groupId={toolGroupId} />}
              {slotTool && <ToolIcon id={slotTool} />}
              <span className="tool-hotkey">{hotbarSlotKey(i)}</span>
            </button>
          );
        })}
      </div>
      {inRail && <p className="dock-hint">Drag to a slot, or <kbd>⌥</kbd> + digit pins it.</p>}
    </div>
  );
}
