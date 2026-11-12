/** A place of the score (quarter-note beats) and the time of the playback there. */
export interface PlaybackMoment { beats: number; timeMs: number }
/** One stretch of the score played in one go; a repeated part has one for each pass. Between its moments the time of a place is linear. */
export interface PlaybackSegment { startBeats: number; endBeats: number; startMs: number; endMs: number; moments: PlaybackMoment[] }
/** A leaf of the score (a note, a chord or a rest) as it is played; a leaf in a repeated part has one for each pass. */
export interface PlaybackAnchor { carrierId: string; startMs: number; endMs: number }
/** A note that sounds, in the order it sounds: the main note for an ornament or an arpeggio. */
export interface PlaybackNote { sourceId: string; pitch: number; startMs: number; keyReleaseMs: number; endMs: number; velocity: number }
export interface PlaybackPedal { downMs: number; upMs: number }
export interface PreviewNote { sourceId: string; pitch: number; velocity: number; durationMs: number }
/** The chord of one note carrier as the preview strikes it. */
export interface PreviewCarrier { version: number; carrierId: string; notes: PreviewNote[] }
export interface PlaybackMap { pedals: PlaybackPedal[]; notes: PlaybackNote[]; anchors: PlaybackAnchor[]; segments: PlaybackSegment[]; extentMs: number; version: number }

export interface PlaybackAudio {
  body: ReadableStream<Uint8Array>;
  sampleRate: number;
  /** Absolute source frame at the beginning of body; omitted means zero. */
  startFrame?: number;
  channels: 2;
  format: 's16le' | 'f32le';
  version: number;
  extentMs: number;
  map?: PlaybackMap;
}

/** The playback map and the chord a click plays of a draft: the server resolves them, and they come
 *  measure by measure with the responses to the draft (see `draftSounds`). */
export interface PlaybackGateway {
  map(draftId: string, signal: AbortSignal): Promise<PlaybackMap>;
  previewCarrier(draftId: string, carrierId: string, signal: AbortSignal): Promise<PreviewCarrier>;
}

/** Read a durable score's playback plan without creating an editing draft. */
export interface SavedScorePlaybackGateway {
  mapScore(scoreId: string, signal: AbortSignal): Promise<PlaybackMap>;
  previewCarrierScore(scoreId: string, carrierId: string, signal: AbortSignal): Promise<PreviewCarrier>;
}
