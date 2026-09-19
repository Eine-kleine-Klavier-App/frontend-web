import { useId, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { springSnappy } from '@/styles/motion';

// The ONE single-choice control: a recessed well holding flat options, the chosen one carried by a
// raised keycap thumb that slides between options. Used for every "pick one of these" set — staff,
// duration, fingering, articulation, stem, time signature — and its thumb (`ChoiceThumb`) is reused
// by the dock's tool and voice rows and the browse nav (tabs, collections), so every selection in
// the app moves the same way.
//
// The thumb is a single `motion.div` that only renders inside the chosen option; switching options
// re-parents it and Motion animates the move (`layoutId`, `springSnappy`). The option itself never
// paints the raised surface — one element, one driver, so a CSS class swap never fights the slide.
// The layout id comes from `useId()`, so two instances (e.g. the outgoing and incoming inspector
// during a crossfade) never fly a thumb between each other.

export interface ChoiceOption<T extends string> {
  value: T;
  label: ReactNode;
  /** accessible name when `label` is a glyph */
  ariaLabel?: string;
  title?: string;
  /** a per-option custom property or modifier class (a voice's colour) */
  className?: string;
  style?: CSSProperties;
}

/** The move an arrow key makes through a row of options: forward (right / down), back (left / up),
 *  or none for any other key. */
export function arrowStep(key: string): -1 | 0 | 1 {
  if (key === 'ArrowRight' || key === 'ArrowDown') return 1;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return -1;
  return 0;
}

/** The raised keycap marking the chosen option. Render it inside the chosen option only, with the
 *  same `groupId` for every option of one group. */
export function ChoiceThumb({ groupId }: { groupId: string }) {
  // reduced motion: the thumb jumps (a slide is movement, not meaning)
  const reduce = useReducedMotion();
  // the thumb measures itself again only when it is a new one (a choice moved here), never because an ancestor was laid out elsewhere — a panel opening shifts the whole page at once, and a thumb gliding alone would lag it
  const own = useId();
  return (
    <motion.span
      className="choice-thumb"
      layoutId={groupId}
      layoutDependency={own}
      transition={reduce ? { duration: 0 } : springSnappy}
      aria-hidden="true"
    />
  );
}

export function ChoiceGroup<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  variant,
  required,
}: {
  /** `null` = no option chosen (e.g. a mixed multi-selection) — no thumb is shown */
  value: T | null;
  onChange: (value: T) => void;
  options: ChoiceOption<T>[];
  ariaLabel: string;
  /** `glyph`: taller options for music glyphs · `wrap`: options flow onto several rows · `tabs`: flat text labels, the choice marked by a line under it */
  variant?: 'glyph' | 'wrap' | 'tabs';
  required?: boolean;
}) {
  const groupId = useId();
  // one radio takes the Tab stop (the chosen one, else the first); arrows move the choice
  const stop = options.some((o) => o.value === value) ? value : options[0]?.value;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const step = arrowStep(e.key);
    if (!step) return;
    const radios = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
    const from = radios.indexOf(document.activeElement as HTMLButtonElement);
    if (from === -1) return;
    e.preventDefault();
    e.stopPropagation();
    const to = (from + step + radios.length) % radios.length;
    radios[to].focus();
    onChange(options[to].value);
  };
  return (
    <div className={'choice' + (variant ? ` choice--${variant}` : '')} role="radiogroup" aria-label={ariaLabel} aria-required={required || undefined} onKeyDown={onKeyDown}>
      {options.map((opt) => {
        const chosen = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            tabIndex={opt.value === stop ? 0 : -1}
            className={'choice-option' + (chosen ? ' active' : '') + (opt.className ? ` ${opt.className}` : '')}
            style={opt.style}
            aria-checked={chosen}
            aria-label={opt.ariaLabel}
            title={opt.title}
            onClick={() => onChange(opt.value)}
          >
            {chosen && <ChoiceThumb groupId={groupId} />}
            <span className="choice-label">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
