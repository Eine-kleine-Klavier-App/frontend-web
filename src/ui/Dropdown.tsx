import { useId, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { glassSettleMotion } from '@/styles/motion';
import { CheckIcon, ChevronDownIcon } from '@/ui/icons';
import { useDismiss } from '@/ui/useDismiss';

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
}

/** A small tokenized dropdown that replaces the native `<select>` — the OS-drawn select popup
 *  broke the warm-paper surface with a jarring system control (round 5). Closes on outside click;
 *  the trigger shows the current label. Deliberately minimal (no typeahead) — it picks
 *  from a handful of options. */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: DropdownOption<T>[];
  onChange: (v: T) => void;
  /** Accessible name for the trigger, e.g. "Sort scores". */
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const current = options.find((o) => o.value === value);
  const reduce = useReducedMotion();
  // settles DOWN from its trigger (the anchor sits above it) — the same arrival as every popover
  const { surface: menuSurface, layer: glassLayer } = glassSettleMotion(reduce, -6);

  useDismiss(open, [rootRef], () => setOpen(false), 'mousedown');

  return (
    <div className="dropdown" ref={rootRef}>
      <button
        type="button"
        className="dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current?.label ?? ''}</span>
        <ChevronDownIcon />
      </button>
      <AnimatePresence>
      {open && (
        <motion.div className="dropdown-menu glass" {...menuSurface}>
          <motion.div className="glass-lens" {...glassLayer} />
          <motion.div className="glass-tint" {...glassLayer} />
          <motion.div className="glass-specular" {...glassLayer} />
          <motion.div className="glass-rim" {...glassLayer} />
          <motion.ul className="dropdown-menu-list" role="listbox" id={listId} aria-label={label} {...glassLayer}>
            {options.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  className={'dropdown-option' + (o.value === value ? ' selected' : '')}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  <span>{o.label}</span>
                  {o.value === value && <CheckIcon />}
                </button>
              </li>
            ))}
          </motion.ul>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  );
}
