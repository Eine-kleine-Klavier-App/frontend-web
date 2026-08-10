/** Personalized difficulty FIT as a single COLOUR + word, not a count of dots — colour carries
 *  "how well it fits" at a glance. Warmer/greener = comfortable, ochre = within reach, berry = a
 *  stretch. The word keeps it accessible (colour alone never carries meaning). */
/** Exported so anything that needs to BUCKET by fit (not just show a badge — e.g. YouScreen's
 *  comfort-zone breakdown) uses these exact thresholds/labels, never a second hand-rolled copy. */
export function fitTier(fit: number): { label: string; cls: string } {
  if (fit >= 0.72) return { label: 'Comfortable', cls: 'fit--comfortable' };
  if (fit >= 0.48) return { label: 'Within reach', cls: 'fit--reach' };
  return { label: 'A stretch', cls: 'fit--stretch' };
}

export function FitBadge({ fit }: { fit: number }) {
  const { label, cls } = fitTier(fit);
  return (
    <span className={'pill ' + cls}>
      <span className="fit-badge-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
