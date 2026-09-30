import type { ContextCoverage, ScoreDocument } from '@/core/model/score';

/** Metadata returned by the score catalog. */
export interface ScoreSummary {
  id: string;
  title: string;
  composer: string | null;
  isPublic: boolean;
  updatedAt: string;
  authorId: string | null;
  authorName: string | null;
}

export type BranchSummary = ScoreSummary & { parentScoreId: string };

export interface DraftSummary {
  id: string;
  title: string;
  refScoreId: string | null;
  updatedAt: string;
}

export interface CollectionSummary {
  id: string;
  name: string;
  scoreCount: number;
}

/** Only operations implemented by the running backend. */
export interface LibraryGateway {
  listPublicScores(): Promise<ScoreSummary[]>;
  listMyScores(): Promise<ScoreSummary[]>;
  listMyDrafts(): Promise<DraftSummary[]>;
  deleteDraft(draftId: string): Promise<void>;
  getScore(id: string): Promise<ScoreSummary | null>;
  getScoreContextCoverage(scoreId: string, contextId: string): Promise<ContextCoverage>;
  getScoreDocument(id: string): Promise<{ score: ScoreSummary; document: ScoreDocument } | null>;
  listAuthorScores(authorId: string): Promise<ScoreSummary[]>;
  listPublicBranches(scoreId: string): Promise<BranchSummary[]>;
  createDraft(fromScoreId?: string): Promise<{ draftId: string }>;
  saveDraftAsScore(draftId: string, details: { title: string; composer: string | null; isPublic: boolean }): Promise<{ scoreId: string }>;
  promoteDraft(draftId: string): Promise<{ scoreId: string }>;
  setScoreVisibility(scoreId: string, isPublic: boolean): Promise<void>;
  updateScoreMetadata(scoreId: string, details: { title: string; composer: string | null }): Promise<void>;
  listMyCollections(): Promise<CollectionSummary[]>;
  createCollection(name: string): Promise<CollectionSummary>;
  renameCollection(collectionId: string, name: string): Promise<void>;
  deleteCollection(collectionId: string): Promise<void>;
  listCollectionScores(collectionId: string): Promise<ScoreSummary[]>;
  addScoreToCollection(collectionId: string, scoreId: string): Promise<void>;
  removeScoreFromCollection(collectionId: string, scoreId: string): Promise<void>;
  listScoreCollectionIds(scoreId: string): Promise<string[]>;
  createScoreBranch(scoreId: string, details: { title: string; composer: string | null; isPublic: boolean }): Promise<{ scoreId: string }>;
}
