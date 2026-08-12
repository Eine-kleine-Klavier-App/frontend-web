import type { ScoreDocument } from '@/core/model/score';

/** Coarse browse category — a real navigational facet (Explore's "Browse by mood" tiles filter
 *  on it), NOT a difficulty claim. Kept deliberately small; a proper taxonomy comes with the
 *  real catalog backend. */
export type Genre = 'classical' | 'romantic' | 'film' | 'pop' | 'jazz' | 'study';

/** A canon (saved) score, as listed in Explore/Library — not the full editable document,
 *  just enough to render a card. `previewDocument` is a pre-sliced few-measure ScoreDocument
 *  (feeds straight into VexflowRenderer, see ScoreThumbnail) — null when `coverImageUrl` is
 *  set instead, which ScoreThumbnail prefers over the notation preview.
 *
 *  `difficultyFit` + `arrangementRating` are the two card signals, MuseScore-shaped but with this
 *  app's twist — see the fields below. The real
 *  values come from the vault's `Score Difficulty Matching` + a publication-quality signal;
 *  neither backend exists yet, so the mock fills them shaped-as-real (same stance as the
 *  recommendation shelves). Deliberately NO static difficulty *tier* (beginner/intermediate/…):
 *  this app's difficulty is a per-user prediction, not a fixed label — a tier would be a lie. */
export interface ScoreSummary {
  id: string;
  title: string;
  composer: string | null;
  isPublic: boolean;
  genre: Genre | null;
  coverImageUrl: string | null;
  previewDocument: ScoreDocument | null;
  updatedAt: string;
  /** Who published THIS arrangement on the platform (the author/arranger, distinct from the
   *  piece's `composer`). Links to their profile (`/authors/:authorId`). */
  authorId: string;
  authorName: string;
  /** Personalized difficulty FIT in 0..1 — "how comfortably could YOU play this right now",
   *  a weighted average over the difficulty criteria (vault: `Score Difficulty Matching`).
   *  Higher = better fit / easier for this user. The per-criterion breakdown behind it is the
   *  detail/panel's job (clickable later); the card shows only the rolled-up meter. */
  difficultyFit: number;
  /** Community quality of THIS arrangement, 0..5 — separate from difficulty (a hard piece can
   *  be a great arrangement). MuseScore-style stars; a publication signal once the catalog is real. */
  arrangementRating: number;
  /** Total views of THIS arrangement's page — an author-facing signal ("Your Scores"), not shown
   *  to a browsing learner. Mocked shaped-as-real, same stance as `difficultyFit`/`arrangementRating`. */
  viewCount: number;
}

/** The three recommendation goals from the vault's `Recommendation Weight Presets` — Explore's
 *  suggestions are organized by these, NOT by arbitrary "new"/"mood" shelves:
 *   - `skill-fit`  → matches current mastery level (comfortable to play well right now)
 *   - `taste`      → similar to the user's taste profile (familiar, appealing)
 *   - `weak-areas` → targeted training value for the user's current weak spots
 *  The real Recommendation Engine (mastery + taste + preset weighting) isn't built yet, so the
 *  mock partitions fixtures deterministically; the SHAPE is the real one so the engine drops in. */
export type RecommendationPreset = 'skill-fit' | 'taste' | 'weak-areas';

export interface RecommendationShelf {
  preset: RecommendationPreset;
  title: string;
  subtitle: string;
  scores: ScoreSummary[];
}

/** An author/arranger who publishes scores on the platform. Every score points at one via
 *  `authorId`; a profile page (`/authors/:id`) lists all their arrangements. `isMe` unlocks the
 *  extended, management view (edit / visibility / new score) on the same page — a catalog with
 *  search + edit, not a dashboard. Progress/stats live on a SEPARATE page (`/you`, `YouScreen`) —
 *  a different job (glanceable numbers, no search) that doesn't belong mixed into this screen. */
export interface Author {
  id: string;
  name: string;
  handle: string;
  bio: string | null;
  isMe: boolean;
}

/** A named skill dimension (`YouScreen`'s progress snapshot). `level` is never shown as a raw
 *  number — an absolute percentage means nothing on its own. `levelMonthAgo` exists purely as a
 *  comparison point so the UI can derive a qualitative trend direction (improving / declining /
 *  steady) from the two; neither field is ever rendered as text itself. No skill-tracking engine
 *  exists yet — mocked shaped-as-real, same stance as `difficultyFit`/`arrangementRating`. */
export interface SkillMastery {
  skill: string;
  level: number;
  /** the SAME skill's level 30 days ago — the trend comparison point. */
  levelMonthAgo: number;
}

/** A PUBLIC branch (fork) of a score — a derived publication in the vault's fork tree
 *  (`Material Versioning & Publication`). Same card shape as a score plus the `author` who made
 *  the branch (the distinguishing fact — same piece, someone else's take). Listing is mocked;
 *  MAKING a branch is real (`createDraft(fromScoreId)` forks straight into the editor). */
export type BranchSummary = ScoreSummary & { author: string; parentScoreId: string };

/** A working draft, as listed in Library's "Continue editing". `refScoreId` is the canon
 *  score it was branched from, or null for a from-scratch draft. */
export interface DraftSummary {
  id: string;
  title: string;
  refScoreId: string | null;
  coverImageUrl: string | null;
  previewDocument: ScoreDocument | null;
  updatedAt: string;
}

/** A recently-practiced piece, for Library's "Jump back in" (docs/browse-redesign.md — Library
 *  is the home for the user's whole relationship with material, not an editor file list). Shallow
 *  mock until the Practice/Session modules exist; `progress` is 0..1 of the piece worked through. */
export type PracticeSummary = ScoreSummary & { lastPracticedAt: string; progress: number };

/** A recently-listened (preview-played) piece, for Library's "Jump back in". Shallow mock. */
export type ListenSummary = ScoreSummary & { listenedAt: string };

/** A user-named group of saved scores (Library's organizing unit, replacing one flat "Your
 *  scores" dump — a score not listed in any collection's `scoreIds` still shows up under
 *  Library's "Unsorted" fallback, so nothing becomes unreachable). */
export interface Collection {
  id: string;
  name: string;
  scoreIds: string[];
}

/**
 * The seam between Explore/Library and wherever score/draft listings come from.
 *
 * The three listing methods are mocked (`MockLibraryGateway`, fixture data) — no backend
 * surface exists yet for browsing/listing. `createDraft` is NOT mocked: `POST /drafts` /
 * `POST /drafts/from-score/{id}` already exist backend-side (same as draft/edit via
 * `EditorGateway`), and the id it returns is immediately used to navigate into the real
 * editor, so a fixture id there would just 404. Swapping the three listings for a real
 * `HttpLibraryGateway` later is a drop-in, same seam as `EditorGateway`.
 */
export interface LibraryGateway {
  listPublicScores(): Promise<ScoreSummary[]>;
  /** Explore's recommendation sections, one per weight preset (see `RecommendationShelf`). */
  listRecommendations(): Promise<RecommendationShelf[]>;
  listMyScores(): Promise<ScoreSummary[]>;
  listMyDrafts(): Promise<DraftSummary[]>;
  /** Recently-practiced pieces for Library's "Jump back in" (shallow mock for now). */
  listRecentPractice(): Promise<PracticeSummary[]>;
  /** Recently listened-to (preview-played) pieces for Library's "Jump back in" (shallow mock). */
  listRecentListens(): Promise<ListenSummary[]>;
  listMyCollections(): Promise<Collection[]>;
  /** A single score for the contextual preview panel — null if no such score. */
  getScore(id: string): Promise<ScoreSummary | null>;
  /** An author's public profile (`/authors/:id`) — null if unknown. */
  getAuthor(id: string): Promise<Author | null>;
  /** Every arrangement published by an author (for their profile grid). */
  listAuthorScores(authorId: string): Promise<ScoreSummary[]>;
  /** Public branches (forks) of a score, for the preview panel's "Other versions" list.
   *  Mocked for now; the real fork tree comes with the publication backend. */
  listPublicBranches(scoreId: string): Promise<BranchSummary[]>;
  /** Your progress snapshot — mastery per named skill (`YouScreen`). Shallow mock. */
  listSkillMastery(): Promise<SkillMastery[]>;
  /** Moves a score you own between private and public. Mocked — mutates the fixture in place, so
   *  it's immediately reflected everywhere else that reads `isPublic` (Explore,
   *  `listPublicScores`, etc.), same as a real toggle would be. */
  setScoreVisibility(scoreId: string, isPublic: boolean): Promise<void>;
  /** Creates a new draft — blank, or branched from a score — and returns its id so the
   *  caller can navigate to `/edit/:draftId`. */
  createDraft(fromScoreId?: string): Promise<{ draftId: string }>;
}
