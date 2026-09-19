import { useId, type KeyboardEvent } from 'react';
import { ChoiceThumb, arrowStep, type ChoiceOption } from './ChoiceGroup';

export function MultiChoice<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  grid = false,
}: {
  value: T[];
  options: (ChoiceOption<T> & { disabled?: boolean })[];
  onChange: (value: T[]) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** short labels (numbers): equal square cells in as many columns as fit, instead of three wide ones per row */
  grid?: boolean;
}) {
  const groupId = useId();
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const step = arrowStep(event.key);
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (from < 0) return;
    event.preventDefault();
    event.stopPropagation();
    const to = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (from + step + buttons.length) % buttons.length;
    buttons[to].focus();
  };
  return (
    <div className={`choice ${grid ? 'choice--grid' : 'choice--wrap'} multi-choice`} role="group" aria-label={ariaLabel} aria-disabled={disabled || undefined} onKeyDown={onKeyDown}>
      {options.map((option) => {
        const chosen = value.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            className={'choice-option' + (chosen ? ' active' : '') + (option.className ? ` ${option.className}` : '')}
            style={option.style}
            aria-label={option.ariaLabel}
            aria-pressed={chosen}
            title={option.title}
            disabled={disabled || option.disabled}
            onClick={() => onChange(chosen ? value.filter((item) => item !== option.value) : [...value, option.value])}
          >
            {chosen && <ChoiceThumb groupId={`${groupId}-${option.value}`} />}
            <span className="choice-label">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
