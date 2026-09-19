import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

/** A labelled slider: its name and current value on one row, the range under it. The rest of the
 *  props go to the range input. */
export function RangeField({
  label,
  output,
  ...input
}: { label: ReactNode; output: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'type' | 'className'>) {
  const id = useId();
  return (
    <>
      <div className="range-field-label">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{output}</output>
      </div>
      <input {...input} id={id} type="range" className="range-field" />
    </>
  );
}
