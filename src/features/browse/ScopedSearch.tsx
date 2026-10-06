import { CloseIcon, SearchIcon } from '@/ui/icons';

/** Scope-aware search field (docs/browse-redesign.md, round 1/2). Search is contextual, not one
 *  fixed global box: the same component searches the whole catalog on Explore, a single
 *  collection inside that collection, an author's scores on their profile. The `scope` label is
 *  shown in the placeholder so the user always knows what they're searching. */
export function ScopedSearch({
  value,
  onChange,
  scope,
  visiblePrompt,
  typing,
}: {
  value: string;
  onChange: (v: string) => void;
  /** What the search is bounded to right now, e.g. "all pieces", "Warm-ups", "Bach". */
  scope: string;
  /** Presentation is owned by AppShell so it survives keyed route scenes and rapid reversals. */
  visiblePrompt: string;
  typing: boolean;
}) {
  const prompt = `Search ${scope}`;

  return (
    <div className="scoped-search">
      <SearchIcon />
      <div className="scoped-search-field">
        {!value && (
          <span className="scoped-search-placeholder" aria-hidden="true">
            {visiblePrompt}
            {typing && <span className="scoped-search-type-caret" />}
          </span>
        )}
        <input
          type="search"
          className="scoped-search-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={prompt}
        />
      </div>
      {value && (
        <button type="button" className="scoped-search-clear" onClick={() => onChange('')} aria-label="Clear search">
          <CloseIcon />
        </button>
      )}
    </div>
  );
}
