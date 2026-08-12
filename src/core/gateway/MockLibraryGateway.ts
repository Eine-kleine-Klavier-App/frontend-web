import type { DurationValue, Measure, ScoreDocument } from '@/core/model/score';
import type {
  Author,
  BranchSummary,
  Collection,
  DraftSummary,
  Genre,
  LibraryGateway,
  ListenSummary,
  PracticeSummary,
  RecommendationShelf,
  ScoreSummary,
  SkillMastery,
} from './LibraryGateway';
import { API_BASE } from './apiBase';
import { CURRENT_AUTHOR_ID } from './authorId';
import { authorizedFetch } from '@/core/auth/authorizedFetch';

/** Builds a short multi-measure, one-voice, one-staff preview from a handful of staff steps —
 *  enough of an excerpt to read as a real snippet on the cover (a single measure looked bare).
 *  `measures` is a parameter, not a baked-in count: nothing downstream assumes one measure. */
function previewDocument(
  id: string,
  staffSteps: number[],
  duration: DurationValue = 'q',
  measures = 3,
): ScoreDocument {
  const measureList: Measure[] = Array.from({ length: measures }, (_, m) => ({
    id: `${id}-m${m}`,
    timeSignature: { beats: 4, beatValue: 4 },
    voices: [
      {
        id: `${id}-v0`,
        items: staffSteps.map((staffStep, i) => ({
          id: `${id}-item${m}-${i}`,
          kind: 'note' as const,
          duration,
          dots: 0,
          notes: [{ noteId: `${id}-note${m}-${i}`, staffId: `${id}-staff`, staffStep, accidental: null }],
        })),
      },
    ],
  }));
  return {
    id,
    title: '',
    staffOrder: [`${id}-staff`],
    voices: [{ id: `${id}-v0`, index: 0 }],
    measures: measureList,
  };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();

interface Seed {
  id: string;
  title: string;
  composer: string | null;
  genre: Genre | null;
  steps: number[];
  duration?: DurationValue;
  ageDays: number;
  isPublic?: boolean;
}

const SEEDS: Seed[] = [
  { id: 'score-clair-de-lune', title: 'Clair de Lune', composer: 'Claude Debussy', genre: 'romantic', steps: [4, 6, 8, 6, 4], ageDays: 0.8 },
  { id: 'score-gymnopedie', title: 'Gymnopédie No. 1', composer: 'Erik Satie', genre: 'classical', steps: [2, 5, 2, 7], duration: 'h', ageDays: 3 },
  { id: 'score-nocturne-eb', title: 'Nocturne in E♭ Major', composer: 'Frédéric Chopin', genre: 'romantic', steps: [3, 5, 7, 5, 3, 5], duration: '8', ageDays: 6 },
  { id: 'score-river-flows', title: 'River Flows in You', composer: 'Yiruma', genre: 'pop', steps: [6, 4, 6, 8], ageDays: 30 },
  { id: 'score-autumn-etude', title: 'Autumn Etude', composer: null, genre: 'study', steps: [5, 7, 5, 3], ageDays: 0.1, isPublic: false },
  { id: 'score-fur-elise-simple', title: 'Für Elise — simplified', composer: 'Ludwig van Beethoven', genre: 'classical', steps: [8, 7, 8, 7, 8, 3, 6, 4], ageDays: 9 },
  { id: 'score-comptine', title: "Comptine d'un autre été", composer: 'Yann Tiersen', genre: 'film', steps: [7, 5, 3, 5, 7], ageDays: 1.5 },
  { id: 'score-merry-christmas', title: 'Merry Christmas Mr. Lawrence', composer: 'Ryuichi Sakamoto', genre: 'film', steps: [4, 8, 6, 9], duration: '8', ageDays: 2.2 },
  { id: 'score-prelude-c', title: 'Prelude in C Major', composer: 'J. S. Bach', genre: 'classical', steps: [0, 2, 4, 7, 4, 2], duration: '8', ageDays: 12 },
  { id: 'score-moonlight', title: 'Moonlight Sonata — 1st mvt', composer: 'Ludwig van Beethoven', genre: 'romantic', steps: [2, 5, 7, 2, 5, 7], duration: '8', ageDays: 5 },
  { id: 'score-blue-bossa', title: 'Blue Bossa', composer: 'Kenny Dorham', genre: 'jazz', steps: [3, 5, 6, 8, 6, 5], ageDays: 4 },
  { id: 'score-hanon-1', title: 'Hanon Exercise No. 1', composer: 'Charles-Louis Hanon', genre: 'study', steps: [0, 1, 2, 3, 4, 3, 2, 1], duration: '8', ageDays: 0.3 },
  { id: 'score-interstellar', title: 'Interstellar — Main Theme', composer: 'Hans Zimmer', genre: 'film', steps: [4, 4, 6, 8], duration: 'h', ageDays: 1.1 },
  { id: 'score-take-five', title: 'Take Five', composer: 'Paul Desmond', genre: 'jazz', steps: [5, 7, 8, 5, 7], ageDays: 7 },
];

/** Stable pseudo-value in [0,1) from a string — lets the mock derive plausible, DETERMINISTIC
 *  difficulty-fit / rating numbers per piece without hand-authoring 14 pairs (and without any
 *  claim to meaning: the real values come from the difficulty + publication engines later). */
function hash01(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

const CURRENT = CURRENT_AUTHOR_ID;

const AUTHORS: Record<string, { name: string; handle: string; bio: string | null }> = {
  [CURRENT]: { name: 'You', handle: '@you', bio: 'Your arrangements and works in progress.' },
  'mira.k': { name: 'Mira K.', handle: '@mira.k', bio: 'Gentle, simplified arrangements for early learners.' },
  'leon_p': { name: 'Leon P.', handle: '@leon_p', bio: 'Jazz voicings and re-harmonizations.' },
  'anna_v': { name: 'Anna V.', handle: '@anna_v', bio: 'Film and game themes, arranged for piano.' },
};

// A few seeds attributed to other authors so Explore + profiles have varied authorship; the rest
// are yours.
const SEED_AUTHOR: Record<string, string> = {
  'score-gymnopedie': 'mira.k',
  'score-comptine': 'mira.k',
  'score-blue-bossa': 'leon_p',
  'score-take-five': 'leon_p',
  'score-interstellar': 'anna_v',
  'score-merry-christmas': 'anna_v',
};

const SCORES: ScoreSummary[] = SEEDS.map((s) => ({
  id: s.id,
  title: s.title,
  composer: s.composer,
  isPublic: s.isPublic ?? true,
  genre: s.genre,
  authorId: SEED_AUTHOR[s.id] ?? CURRENT,
  authorName: AUTHORS[SEED_AUTHOR[s.id] ?? CURRENT].name,
  coverImageUrl: null,
  previewDocument: previewDocument(s.id, s.steps, s.duration ?? 'q'),
  updatedAt: new Date(now - s.ageDays * DAY).toISOString(),
  // fit 0.40..0.98, rating 3.6..5.0, views 20..500 — mock-shaped-as-real (see LibraryGateway.ScoreSummary).
  difficultyFit: 0.4 + hash01(s.id) * 0.58,
  arrangementRating: 3.6 + hash01(s.id + 'r') * 1.4,
  viewCount: Math.round(20 + hash01(s.id + 'v') * 480),
}));

const DRAFTS: DraftSummary[] = [
  {
    id: 'draft-untitled-1',
    title: 'Untitled draft',
    refScoreId: null,
    coverImageUrl: null,
    previewDocument: previewDocument('draft-untitled-1', [4, 6, 8]),
    updatedAt: new Date(now - 12 * 60_000).toISOString(),
  },
  {
    id: 'draft-clair-de-lune-mine',
    title: 'Clair de Lune (my take)',
    refScoreId: 'score-clair-de-lune',
    coverImageUrl: null,
    previewDocument: previewDocument('draft-clair-de-lune-mine', [4, 6, 8, 9, 6]),
    updatedAt: new Date(now - 22 * HOUR).toISOString(),
  },
  {
    id: 'draft-warmup-sketch',
    title: 'Warmup sketch',
    refScoreId: null,
    coverImageUrl: null,
    previewDocument: previewDocument('draft-warmup-sketch', [5, 7], 'h'),
    updatedAt: new Date(now - 4 * 24 * HOUR).toISOString(),
  },
];

// Shallow mock-shaped-as-real skill snapshot (YouScreen) — no skill-tracking engine exists yet,
// same stance as difficultyFit; static rather than hash-derived since it represents ONE simulated
// user's own progress, not a per-piece value. Hand independence is deliberately a slight
// REGRESSION (0.44 → 0.41) — not every skill trends up, and only showing gains would be dishonest.
const SKILLS: SkillMastery[] = [
  { skill: 'Sight-reading', level: 0.58, levelMonthAgo: 0.50 },
  { skill: 'Rhythm & timing', level: 0.74, levelMonthAgo: 0.71 },
  { skill: 'Hand independence', level: 0.41, levelMonthAgo: 0.44 },
  { skill: 'Dynamics & phrasing', level: 0.66, levelMonthAgo: 0.52 },
];

const COLLECTIONS: Collection[] = [
  { id: 'collection-warmups', name: 'Warm-ups', scoreIds: ['score-gymnopedie', 'score-river-flows'] },
  {
    id: 'collection-recital',
    name: 'Recital pieces',
    scoreIds: ['score-clair-de-lune', 'score-nocturne-eb', 'score-fur-elise-simple'],
  },
  // 'score-autumn-etude' is deliberately left out of both — exercises the "Unsorted" fallback.
];

function delay<T>(value: T): Promise<T> {
  // Resolves on the next microtask — still genuinely async (real await/loading-state code paths
  // are exercised), but WITHOUT faking network latency. A real backend will have its own real
  // latency later; this mock has none, so it shouldn't pretend to.
  return Promise.resolve(value);
}

export class MockLibraryGateway implements LibraryGateway {
  listPublicScores(): Promise<ScoreSummary[]> {
    return delay(SCORES.filter((s) => s.isPublic));
  }

  listRecommendations(): Promise<RecommendationShelf[]> {
    // Deterministic mock partition — the real engine ranks by mastery/taste/preset weights
    // (vault: Recommendation Engine). Here just slice the public catalog into three buckets so
    // the section SHAPE is exercised; overlap between buckets is fine and realistic.
    const pub = SCORES.filter((s) => s.isPublic);
    // exactly 4 per section — a full row in the fixed 4-column mosaic (2 rows at the 2-col
    // narrow breakpoint), so every tile is the same size AND no row has a trailing gap.
    const pick = (start: number) => pub.filter((_, i) => i % 3 === start % 3).slice(0, 4);
    return delay([
      {
        preset: 'skill-fit',
        title: 'Right for your level',
        subtitle: 'Comfortable to play well right now',
        scores: pick(0),
      },
      {
        preset: 'taste',
        title: 'Made for your taste',
        subtitle: 'Close to what you already love',
        scores: pick(1),
      },
      {
        preset: 'weak-areas',
        title: 'Grow your weak spots',
        subtitle: 'Targeted practice where it helps most',
        scores: pick(2),
      },
    ]);
  }

  listMyScores(): Promise<ScoreSummary[]> {
    return delay(SCORES);
  }

  listMyDrafts(): Promise<DraftSummary[]> {
    return delay(DRAFTS);
  }

  listRecentPractice(): Promise<PracticeSummary[]> {
    // Shallow mock — recently-practiced saved pieces with a progress fraction.
    const picks = ['score-gymnopedie', 'score-river-flows'];
    const items: PracticeSummary[] = picks.flatMap((id, i) => {
      const s = SCORES.find((x) => x.id === id);
      return s
        ? [{ ...s, lastPracticedAt: new Date(now - (i * 5 + 1) * HOUR).toISOString(), progress: 0.3 + hash01(id + 'p') * 0.6 }]
        : [];
    });
    return delay(items);
  }

  listRecentListens(): Promise<ListenSummary[]> {
    // Shallow mock — recently preview-played pieces.
    const picks = ['score-nocturne-eb', 'score-comptine', 'score-take-five'];
    const items: ListenSummary[] = picks.flatMap((id, i) => {
      const s = SCORES.find((x) => x.id === id);
      return s ? [{ ...s, listenedAt: new Date(now - (i * 3 + 4) * HOUR).toISOString() }] : [];
    });
    return delay(items);
  }

  listMyCollections(): Promise<Collection[]> {
    return delay(COLLECTIONS);
  }

  getScore(id: string): Promise<ScoreSummary | null> {
    return delay(SCORES.find((s) => s.id === id) ?? null);
  }

  // Shallow mock of the fork tree: 0..2 public branches per score, deterministic. The real list
  // comes from the publication backend; making a branch is already real (createDraft).
  listPublicBranches(scoreId: string): Promise<BranchSummary[]> {
    const base = SCORES.find((s) => s.id === scoreId);
    if (!base) return delay([]);
    const variants = [
      { suffix: '— simplified', author: 'mira.k', fitBump: 0.2 },
      { suffix: '— jazz take', author: 'leon_p', fitBump: -0.15 },
    ];
    const count = hash01(scoreId + 'b') < 0.4 ? 0 : hash01(scoreId + 'b') < 0.75 ? 1 : 2;
    const branches: BranchSummary[] = variants.slice(0, count).map((v, i) => ({
      ...base,
      id: `${scoreId}-branch-${i}`,
      parentScoreId: scoreId,
      title: `${base.title} ${v.suffix}`,
      author: v.author,
      authorId: v.author,
      authorName: AUTHORS[v.author]?.name ?? v.author,
      difficultyFit: Math.max(0.35, Math.min(0.98, base.difficultyFit + v.fitBump)),
      arrangementRating: 3.6 + hash01(scoreId + v.author) * 1.4,
    }));
    return delay(branches);
  }

  listSkillMastery(): Promise<SkillMastery[]> {
    return delay(SKILLS);
  }

  setScoreVisibility(scoreId: string, isPublic: boolean): Promise<void> {
    const s = SCORES.find((x) => x.id === scoreId);
    if (s) s.isPublic = isPublic;
    return delay(undefined);
  }

  getAuthor(id: string): Promise<Author | null> {
    const a = AUTHORS[id];
    if (!a) return delay(null);
    return delay({ id, name: a.name, handle: a.handle, bio: a.bio, isMe: id === CURRENT });
  }

  listAuthorScores(authorId: string): Promise<ScoreSummary[]> {
    const isMe = authorId === CURRENT;
    return delay(SCORES.filter((s) => s.authorId === authorId && (isMe || s.isPublic)));
  }

  // NOT mocked, unlike the three listings above: the editor the caller navigates to
  // (`/edit/:draftId`) always talks to the REAL backend (HttpGateway) — a fixture id here
  // would 404 the moment the new screen loads. `POST /drafts` / `POST /drafts/from-score/{id}`
  // already exist backend-side (unlike listing, which doesn't), so this goes straight through.
  // Caveat this doesn't fix: the fixture SCORES above aren't real backend rows, so branching
  // from one of these mock cards still 404s ("Score not found.") until real Explore/Library
  // listing endpoints return real score ids — that gap needs backend work, not more mocking.
  async createDraft(fromScoreId?: string): Promise<{ draftId: string }> {
    const url = fromScoreId
      ? `${API_BASE}/drafts/from-score/${encodeURIComponent(fromScoreId)}`
      : `${API_BASE}/drafts`;
    const res = await authorizedFetch(url, { method: 'POST' });
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const detail =
        body && typeof body === 'object' && 'detail' in body ? String((body as { detail: unknown }).detail) : null;
      throw new Error(detail ?? `Failed to create draft (${res.status})`);
    }
    const body = (await res.json()) as { draft_id: string };
    return { draftId: body.draft_id };
  }
}
