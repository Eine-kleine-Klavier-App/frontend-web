/** Scope-aware search field (docs/browse-redesign.md, round 1/2). Search is contextual, not one
 *  fixed global box: the same component searches the whole catalog on Explore, a single
 *  collection inside that collection, an author's scores on their profile. The `scope` label is
 *  shown in the placeholder so the user always knows what they're searching. */
function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function ScopedSearch({
  value,
  onChange,
  scope,
}: {
  value: string;
  onChange: (v: string) => void;
  /** What the search is bounded to right now, e.g. "all pieces", "Warm-ups", "Bach". */
  scope: string;
}) {
  return (
    <div className="scoped-search">
      <SearchIcon />
      <input
        type="search"
        className="scoped-search-input"
        placeholder={`Search ${scope}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`Search ${scope}`}
      />
      {value && (
        <button type="button" className="scoped-search-clear" onClick={() => onChange('')} aria-label="Clear search">
          ×
        </button>
      )}
    </div>
  );
}
