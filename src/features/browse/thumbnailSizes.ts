// Centralized thumbnail sizing for Explore/Library — every card/row shares these instead of
// each screen hardcoding its own px pair, so a future size change is a one-line edit here
// rather than a hunt across ExploreScreen.tsx/LibraryScreen.tsx.
//
// All SQUARE (1:1) now — Spotify/Apple Music/flowkey/MuseScore's own libraries all use square
// (or near-square) "cover" art for grid tiles and list rows alike; the earlier wide rectangles
// (260x116, 40x40 stayed accidentally square but the grid ones didn't) read as "dumb"
// proportions with no consistent rhythm across the page. Every size below is a clean square.
export const EXPLORE_CARD_THUMB = { width: 220, height: 220 } as const;
// The single most-recent draft on Library renders as a hero "resume" card — one focal point
// instead of N equal-weight tiles (design-audit: "hierarchy drives everything").
export const HERO_DRAFT_THUMB = { width: 128, height: 128 } as const;
export const DRAFT_ROW_THUMB = { width: 48, height: 48 } as const;
export const SCORE_ROW_THUMB = { width: 48, height: 48 } as const;
// The score detail page's own larger cover (see ScoreDetailScreen.tsx).
export const DETAIL_COVER_THUMB = { width: 240, height: 240 } as const;
