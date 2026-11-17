import type { BranchSummary, CollectionSummary, DraftSummary, ImportJob, ImportState, LibraryGateway, ScoreSummary } from './LibraryGateway';
import type { ContextCoverage, Fraction, ScoreDocument } from '@/core/model/score';
import { fromView, type ScoreView } from '@/core/model/fromView';
import { API_BASE } from './apiBase';
import { authorizedFetch, optionalAuthFetch } from '@/core/auth/authorizedFetch';

const PAGE_LIMIT = 100;

interface ScoreCardDto {
  id: string;
  title: string;
  composer: string | null;
  author_id: string | null;
  author_name: string | null;
  is_public: boolean;
  updated_at: string;
}

interface DraftCardDto {
  draft_id: string;
  title: string;
  ref_score_id: string | null;
  updated_at: string;
}

interface CollectionDto {
  id: string;
  name: string;
  score_count: number;
}

function toCollectionSummary(dto: CollectionDto): CollectionSummary {
  return { id: dto.id, name: dto.name, scoreCount: dto.score_count };
}

interface PageDto<T> {
  items: T[];
  next_cursor: string | null;
}

function toScoreSummary(dto: ScoreCardDto): ScoreSummary {
  return {
    id: dto.id,
    title: dto.title,
    composer: dto.composer,
    isPublic: dto.is_public,
    updatedAt: dto.updated_at,
    authorId: dto.author_id,
    authorName: dto.author_name,
  };
}

interface ImportJobDto {
  job_id: string;
  state: ImportState;
  draft_id: string | null;
  comparison: { kind: 'skipped' | 'changed' | 'mismatch'; measure_index: number | null; onset: Fraction | null; message: string }[];
  error: string | null;
}

function toImportJob(dto: ImportJobDto): ImportJob {
  return {
    jobId: dto.job_id,
    state: dto.state,
    draftId: dto.draft_id,
    comparison: dto.comparison.map((issue) => ({ kind: issue.kind, measureIndex: issue.measure_index, onset: issue.onset, message: issue.message })),
    error: dto.error,
  };
}

async function readError(res: Response, fallback: string): Promise<Error> {
  const body: unknown = await res.json().catch(() => null);
  const detail =
    body && typeof body === 'object' && 'detail' in body ? String((body as { detail: unknown }).detail) : null;
  return new Error(detail ?? fallback);
}

async function listAllPages(path: string, fetcher: typeof optionalAuthFetch): Promise<ScoreSummary[]> {
  const items: ScoreSummary[] = [];
  let cursor: string | null = null;
  do {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) params.set('cursor', cursor);
    const res = await fetcher(`${API_BASE}${path}?${params}`);
    if (!res.ok) throw await readError(res, `Failed to load scores (${res.status})`);
    const page = (await res.json()) as PageDto<ScoreCardDto>;
    items.push(...page.items.map(toScoreSummary));
    cursor = page.next_cursor;
  } while (cursor);
  return items;
}

export class HttpLibraryGateway implements LibraryGateway {
  listPublicScores(): Promise<ScoreSummary[]> {
    return listAllPages('/scores', optionalAuthFetch);
  }

  listMyScores(): Promise<ScoreSummary[]> {
    return listAllPages('/scores/mine', authorizedFetch);
  }

  async listMyDrafts(): Promise<DraftSummary[]> {
    const res = await authorizedFetch(`${API_BASE}/drafts`);
    if (!res.ok) throw await readError(res, `Failed to load drafts (${res.status})`);
    const dtos = (await res.json()) as DraftCardDto[];
    return dtos.map((dto) => ({
      id: dto.draft_id,
      title: dto.title,
      refScoreId: dto.ref_score_id,
      updatedAt: dto.updated_at,
    }));
  }

  async deleteDraft(draftId: string): Promise<void> {
    const res = await authorizedFetch(`${API_BASE}/drafts/${encodeURIComponent(draftId)}`, { method: 'DELETE' });
    if (!res.ok) throw await readError(res, `Failed to delete draft (${res.status})`);
  }

  async getScore(id: string): Promise<ScoreSummary | null> {
    const res = await optionalAuthFetch(`${API_BASE}/scores/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await readError(res, `Failed to load score (${res.status})`);
    return toScoreSummary((await res.json()) as ScoreCardDto);
  }

  async getScoreContextCoverage(scoreId: string, contextId: string): Promise<ContextCoverage> {
    const res = await optionalAuthFetch(`${API_BASE}/scores/${encodeURIComponent(scoreId)}/contexts/${encodeURIComponent(contextId)}/coverage`);
    if (!res.ok) throw await readError(res, `Failed to read context coverage (${res.status})`);
    const value = (await res.json()) as { carrier_ids: string[]; note_ids: string[] };
    return { carrierIds: value.carrier_ids, noteIds: value.note_ids };
  }

  async getScoreDocument(id: string): Promise<{ score: ScoreSummary; document: ScoreDocument } | null> {
    const res = await optionalAuthFetch(`${API_BASE}/scores/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await readError(res, `Failed to load score (${res.status})`);
    const dto = (await res.json()) as ScoreCardDto & { document: ScoreView };
    return { score: toScoreSummary(dto), document: { ...fromView(dto.document, id), title: dto.title } };
  }

  listAuthorScores(authorId: string): Promise<ScoreSummary[]> {
    return listAllPages(`/authors/${encodeURIComponent(authorId)}/scores`, optionalAuthFetch);
  }

  async listPublicBranches(scoreId: string): Promise<BranchSummary[]> {
    const scores = await listAllPages(`/scores/${encodeURIComponent(scoreId)}/branches`, optionalAuthFetch);
    return scores.map((score) => ({ ...score, parentScoreId: scoreId }));
  }

  async createDraft(fromScoreId?: string): Promise<{ draftId: string }> {
    const path = fromScoreId ? `/drafts/from-score/${encodeURIComponent(fromScoreId)}` : '/drafts';
    const res = await authorizedFetch(`${API_BASE}${path}`, { method: 'POST' });
    if (!res.ok) throw await readError(res, `Failed to create draft (${res.status})`);
    const dto = (await res.json()) as { draft_id: string };
    return { draftId: dto.draft_id };
  }

  /** The file goes up as the raw request body; the answer is the job that reads it in the background. */
  private async postFile(path: string, file: File): Promise<ImportJob> {
    const res = await authorizedFetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) throw await readError(res, `Failed to upload the file (${res.status})`);
    return toImportJob((await res.json()) as ImportJobDto);
  }

  startImport(file: File): Promise<ImportJob> {
    return this.postFile(`/imports?filename=${encodeURIComponent(file.name)}`, file);
  }

  startComparison(draftId: string, file: File): Promise<ImportJob> {
    return this.postFile(`/drafts/${encodeURIComponent(draftId)}/compare?filename=${encodeURIComponent(file.name)}`, file);
  }

  async getImportJob(jobId: string): Promise<ImportJob> {
    const res = await authorizedFetch(`${API_BASE}/imports/${encodeURIComponent(jobId)}`);
    if (!res.ok) throw await readError(res, `Failed to read the import (${res.status})`);
    return toImportJob((await res.json()) as ImportJobDto);
  }

  async saveDraftAsScore(draftId: string, details: { title: string; composer: string | null; isPublic: boolean }): Promise<{ scoreId: string }> {
    const res = await authorizedFetch(`${API_BASE}/drafts/${encodeURIComponent(draftId)}/branches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: details.title, composer: details.composer, is_public: details.isPublic }),
    });
    if (!res.ok) throw await readError(res, `Failed to save score (${res.status})`);
    const dto = (await res.json()) as { score_id: string };
    return { scoreId: dto.score_id };
  }

  async promoteDraft(draftId: string): Promise<{ scoreId: string }> {
    const res = await authorizedFetch(`${API_BASE}/drafts/${encodeURIComponent(draftId)}/promote`, { method: 'POST' });
    if (!res.ok) throw await readError(res, `Failed to save changes (${res.status})`);
    const dto = (await res.json()) as { score_id: string };
    return { scoreId: dto.score_id };
  }

  async setScoreVisibility(scoreId: string, isPublic: boolean): Promise<void> {
    const res = await authorizedFetch(`${API_BASE}/scores/${encodeURIComponent(scoreId)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ is_public: isPublic }),
    });
    if (!res.ok) throw await readError(res, `Failed to change privacy (${res.status})`);
  }

  async updateScoreMetadata(scoreId: string, details: { title: string; composer: string | null }): Promise<void> {
    const res = await authorizedFetch(`${API_BASE}/scores/${encodeURIComponent(scoreId)}/metadata`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(details),
    });
    if (!res.ok) throw await readError(res, `Failed to update score (${res.status})`);
  }

  async createScoreBranch(scoreId: string, details: { title: string; composer: string | null; isPublic: boolean }): Promise<{ scoreId: string }> {
    const res = await authorizedFetch(`${API_BASE}/scores/${encodeURIComponent(scoreId)}/branches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: details.title, composer: details.composer, is_public: details.isPublic }),
    });
    if (!res.ok) throw await readError(res, `Failed to create version (${res.status})`);
    const dto = (await res.json()) as { score_id: string };
    return { scoreId: dto.score_id };
  }

  async listMyCollections(): Promise<CollectionSummary[]> {
    const res = await authorizedFetch(`${API_BASE}/collections`);
    if (!res.ok) throw await readError(res, `Failed to load collections (${res.status})`);
    return ((await res.json()) as CollectionDto[]).map(toCollectionSummary);
  }

  async createCollection(name: string): Promise<CollectionSummary> {
    const res = await authorizedFetch(`${API_BASE}/collections`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    if (!res.ok) throw await readError(res, `Failed to create collection (${res.status})`);
    return toCollectionSummary((await res.json()) as CollectionDto);
  }

  async renameCollection(collectionId: string, name: string): Promise<void> {
    const res = await authorizedFetch(`${API_BASE}/collections/${encodeURIComponent(collectionId)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    if (!res.ok) throw await readError(res, `Failed to rename collection (${res.status})`);
  }

  async deleteCollection(collectionId: string): Promise<void> {
    const res = await authorizedFetch(`${API_BASE}/collections/${encodeURIComponent(collectionId)}`, { method: 'DELETE' });
    if (!res.ok) throw await readError(res, `Failed to delete collection (${res.status})`);
  }

  listCollectionScores(collectionId: string): Promise<ScoreSummary[]> {
    return listAllPages(`/collections/${encodeURIComponent(collectionId)}/scores`, authorizedFetch);
  }

  async addScoreToCollection(collectionId: string, scoreId: string): Promise<void> {
    const res = await authorizedFetch(
      `${API_BASE}/collections/${encodeURIComponent(collectionId)}/scores/${encodeURIComponent(scoreId)}`, { method: 'PUT' });
    if (!res.ok) throw await readError(res, `Failed to add to collection (${res.status})`);
  }

  async removeScoreFromCollection(collectionId: string, scoreId: string): Promise<void> {
    const res = await authorizedFetch(
      `${API_BASE}/collections/${encodeURIComponent(collectionId)}/scores/${encodeURIComponent(scoreId)}`, { method: 'DELETE' });
    if (!res.ok) throw await readError(res, `Failed to remove from collection (${res.status})`);
  }

  async listScoreCollectionIds(scoreId: string): Promise<string[]> {
    const res = await authorizedFetch(`${API_BASE}/scores/${encodeURIComponent(scoreId)}/collections`);
    if (!res.ok) throw await readError(res, `Failed to load collections (${res.status})`);
    return ((await res.json()) as { collection_ids: string[] }).collection_ids;
  }
}
