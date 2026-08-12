import { useEffect, useId, useRef, useState } from 'react';
import { CheckIcon, ChevronDownIcon } from '@/ui/icons';

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
}

/** A small tokenized dropdown that replaces the native `<select>` — the OS-drawn select popup
 *  broke the warm-paper surface with a jarring system control (round 5). Closes on outside click
 *  or Escape; the trigger shows the current label. Deliberately minimal (no typeahead) — it picks
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

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

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
      {open && (
        <div className="dropdown-menu glass">
          <div className="glass-lens" />
          <div className="glass-tint" />
          <div className="glass-specular" />
          <div className="glass-rim" />
          <ul className="dropdown-menu-list" role="listbox" id={listId} aria-label={label}>
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
          </ul>
        </div>
      )}
    </div>
  );
}
