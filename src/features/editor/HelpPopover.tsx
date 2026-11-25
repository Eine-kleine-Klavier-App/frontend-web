import { useId, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { HelpIcon } from '@/ui/icons';
import { settleMotion } from '@/styles/motion';
import { useDismiss } from '@/ui/useDismiss';

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'V', action: 'Select tool, clear selection' },
  { keys: '1 – 0', action: 'Tool in that dock slot' },
  { keys: '← →', action: 'Previous / next note' },
  { keys: '↑ ↓', action: 'Move selected notes one staff step' },
  { keys: '⌥ ← →', action: 'Write in the previous / next voice' },
  { keys: '⌥ ↑ ↓', action: 'Write on the staff above / below' },
  { keys: '⌥ 1 – 0', action: 'Pin the armed element to that slot' },
  { keys: '/', action: 'Search the library' },
  { keys: 'S  P', action: 'In the clef question: keep sound / keep position' },
  { keys: 'Shift', action: 'Extend the selection' },
  { keys: '⌘Z  ⇧⌘Z', action: 'Undo / redo' },
  { keys: '⌫', action: 'Delete the selection' },
];

const WATERFALL_KEYS: { keys: string; action: string }[] = [
  { keys: '\\', action: 'Hide or show this panel' },
];

const PRACTICE_HELP =
  'The line waits at each note until your keyboard plays it, then runs on at the pace of the score and waits again. Press any key to choose the keyboard; the keyboard has to be in the list of MIDI devices of the system first. Wrong keys are ignored; a chord counts when its keys are struck close together. Listen plays the score from the line, and the practice goes on from the same place when it stops.';

const PRACTICE_KEYS: { keys: string; action: string }[] = [
  { keys: '\\', action: 'Hide or show this panel' },
];

/** The "?" in the desk's bottom-left corner: how editing works, on demand. It holds what the old
 *  left panel's hint said (staff + voice targeting, cross-staff chords) plus the shortcuts. A plate
 *  that settles up from its button — not glass; glass stays on the two approved popovers. */
export function HelpPopover({ topic = 'editing' }: { topic?: 'editing' | 'waterfall' | 'practice' }) {
  const waterfall = topic === 'waterfall';
  const practice = topic === 'practice';
  const name = practice ? 'Practice' : waterfall ? 'Waterfall' : 'Editing';
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const reduce = useReducedMotion();

  useDismiss(open, [rootRef], () => setOpen(false));

  return (
    <div className="help" ref={rootRef}>
      <button
        type="button"
        className={'icon-btn help-toggle' + (open ? ' active' : '')}
        aria-label={`${name} help`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <HelpIcon />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            id={panelId}
            className="help-popover"
            role="dialog"
            aria-label={`${name} help`}
            // settles up from its "?" button, lifts away on close
            {...settleMotion(reduce, 6)}
          >
            <h3>{name}</h3>
            <p>
              {practice
                ? PRACTICE_HELP
                : waterfall
                ? 'The notes fall onto the keys, each in the colour of its voice. Play, Stop and the position bar are in the top bar; the voice colours and the sky are set here. The Editor tab goes back to the score.'
                : 'New notes go to the current staff and voice, chosen above the sheet. Switch staff and click the same beat again to build a cross-staff chord — a voice is global, so it can place notes on either staff.'}
            </p>
            <dl className="help-keys">
              {(practice ? PRACTICE_KEYS : waterfall ? WATERFALL_KEYS : SHORTCUTS).map(({ keys, action }) => (
                <div key={keys}>
                  <dt><kbd>{keys}</kbd></dt>
                  <dd>{action}</dd>
                </div>
              ))}
            </dl>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
