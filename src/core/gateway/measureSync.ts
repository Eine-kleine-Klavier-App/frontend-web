import type { ScoreView } from '@/core/model/fromView';

/** One measure's share of the document view, as the server cuts the view by measure. */
export interface MeasureShare {
  measure: ScoreView['measures'][number];
  voice_roots: { voice_id: string; rhythmic_container_ids: string[] }[];
  rhythmic_containers: ScoreView['rhythmic_containers'];
  carriers: ScoreView['carriers'];
  items: ScoreView['items'];
  relations: ScoreView['relations'];
  contexts: NonNullable<ScoreView['contexts']>;
  insertion_spaces: NonNullable<ScoreView['insertion_spaces']>;
  presentation: NonNullable<ScoreView['presentation']>;
  presentation_capabilities: NonNullable<ScoreView['presentation_capabilities']>;
}

/** What belongs to no one measure. */
export interface SyncHeader {
  music_revision: string;
  staffs: ScoreView['staffs'];
  measure_ids: string[];
  voice_ids: string[];
  presentation: NonNullable<ScoreView['presentation']>;
  presentation_capabilities: NonNullable<ScoreView['presentation_capabilities']>;
}

export interface WireStrike { note_id: string; pitch: number; velocity: number }
export interface WireNote { source_id: string; pitch: number; start_ms: number; key_release_ms: number; end_ms: number; velocity: number }
export interface WireAnchor { carrier_id: string; start_ms: number; end_ms: number }
export interface WireSegment { start: unknown; end: unknown; start_ms: number; end_ms: number; moments: { position: unknown; time_ms: number }[] }

/** One measure's share of the sound: what a click on each note plays, and the playback notes and
 *  leaves that start in it, in the times of the whole score. */
export interface MeasureSoundsWire { measure_id: string; strikes: WireStrike[]; notes: WireNote[]; anchors: WireAnchor[] }
export interface TimingWire { extent_ms: number; pedals: { down_ms: number; up_ms: number }[]; segments: WireSegment[] }

/** A response by measure: `from_version` null is the whole score. */
export interface MeasureSyncWire {
  from_version: number | null;
  to_version: number;
  header: SyncHeader | null;
  measures: MeasureShare[];
  sounds: MeasureSoundsWire[];
  timing: TimingWire | null;
  removed: string[];
  sound_error: string | null;
}

/** The document view of one draft as the client holds it, measure by measure. */
export class DraftSync {
  private version: number | null = null;
  private header: SyncHeader | null = null;
  private shares = new Map<string, MeasureShare>();

  /** Takes a response in and gives the whole view put together again; null when the response
   *  does not follow the version held (the client then loads the score whole). */
  apply(sync: MeasureSyncWire): ScoreView | null {
    if (sync.from_version !== null && sync.from_version !== this.version) return null;
    if (sync.from_version === null) this.shares.clear();
    if (sync.header) this.header = sync.header;
    for (const measureId of sync.removed) this.shares.delete(measureId);
    for (const share of sync.measures) this.shares.set(share.measure.id, share);
    this.version = sync.to_version;
    return this.view();
  }

  private view(): ScoreView | null {
    const header = this.header;
    if (!header) return null;
    const shares: MeasureShare[] = [];
    for (const measureId of header.measure_ids) {
      const share = this.shares.get(measureId);
      if (!share) return null;
      shares.push(share);
    }
    const roots = new Map<string, string[]>(header.voice_ids.map((voiceId) => [voiceId, []]));
    for (const share of shares) {
      for (const root of share.voice_roots) roots.get(root.voice_id)?.push(...root.rhythmic_container_ids);
    }
    const presentation: NonNullable<ScoreView['presentation']> = {
      vertical: [...header.presentation.vertical, ...shares.flatMap((share) => share.presentation.vertical)],
      endpoints: [...header.presentation.endpoints, ...shares.flatMap((share) => share.presentation.endpoints)],
      directions: [...header.presentation.directions, ...shares.flatMap((share) => share.presentation.directions)],
      horizontal: [...header.presentation.horizontal, ...shares.flatMap((share) => share.presentation.horizontal)],
      horizontal_endpoints: [
        ...header.presentation.horizontal_endpoints,
        ...shares.flatMap((share) => share.presentation.horizontal_endpoints),
      ],
    };
    return {
      music_revision: header.music_revision,
      presentation,
      presentation_capabilities: [...header.presentation_capabilities, ...shares.flatMap((share) => share.presentation_capabilities)],
      insertion_spaces: shares.flatMap((share) => share.insertion_spaces),
      staffs: header.staffs,
      measures: shares.map((share) => share.measure),
      voices: header.voice_ids.map((voiceId) => ({ id: voiceId, rhythmic_container_ids: roots.get(voiceId) ?? [] })),
      rhythmic_containers: shares.flatMap((share) => share.rhythmic_containers),
      carriers: shares.flatMap((share) => share.carriers),
      items: shares.flatMap((share) => share.items),
      relations: shares.flatMap((share) => share.relations),
      contexts: shares.flatMap((share) => share.contexts),
    };
  }
}
