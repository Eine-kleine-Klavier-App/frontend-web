import { useAuthStore } from '@/core/auth/authStore';

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
  // Difficulty FIT is a per-user prediction — meaningless without a signed-in user, so it simply
  // isn't shown to anonymous visitors ([[auth-product-model]]). Guarding here covers every call
  // site (cards, hero, preview panel, library, profiles) at once.
  const authed = useAuthStore((s) => s.status === 'authed');
  const { label, cls } = fitTier(fit);
  if (!authed) return null;
  return (
    <span className={'pill ' + cls}>
      <span className="fit-badge-dot" aria-hidden="true" />
      {label}
    </span>
  );
}
