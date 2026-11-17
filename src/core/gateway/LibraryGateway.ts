import type { ContextCoverage, Fraction, ScoreDocument } from '@/core/model/score';

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

export type ImportState = 'queued' | 'reading' | 'building' | 'comparing' | 'done' | 'failed';

/** One difference between a file and a draft; `measureIndex` counts the draft's measures from 0. */
export interface ComparisonIssue {
  kind: 'skipped' | 'changed' | 'mismatch';
  measureIndex: number | null;
  /** where in the measure, in quarter notes from its start (the start of anything that lasts); null when it has no place on a beat */
  onset: Fraction | null;
  message: string;
}

/** An import (a file becomes a draft) or a comparison (how a draft differs from a file), in the
 *  background. What the comparison found is not stored anywhere: a new comparison finds it again. */
export interface ImportJob {
  jobId: string;
  state: ImportState;
  draftId: string | null;
  comparison: ComparisonIssue[];
  error: string | null;
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
  startImport(file: File): Promise<ImportJob>;
  startComparison(draftId: string, file: File): Promise<ImportJob>;
  getImportJob(jobId: string): Promise<ImportJob>;
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
