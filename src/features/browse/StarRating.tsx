/** Arrangement rating as MuseScore-style stars + the numeric value (docs/browse-redesign.md).
 *  Community quality of THIS arrangement — separate from difficulty. Half-steps rendered by
 *  clipping the fill width of the partially-filled star. */
export function StarRating({ rating, showValue = true }: { rating: number; showValue?: boolean }) {
  const clamped = Math.max(0, Math.min(5, rating));
  return (
    <span className="star-rating" role="img" aria-label={`Arrangement rated ${clamped.toFixed(1)} of 5`}>
      <span className="star-rating-stars" aria-hidden="true">
        <span className="star-rating-fill" style={{ width: `${(clamped / 5) * 100}%` }}>
          ★★★★★
        </span>
        <span className="star-rating-base">★★★★★</span>
      </span>
      {showValue && <span className="star-rating-value">{clamped.toFixed(1)}</span>}
    </span>
  );
}
