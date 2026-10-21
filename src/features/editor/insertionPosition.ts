import type { Fraction, ScoreDocument } from '@/core/model/score';

export interface InsertionPosition {
  position: Fraction;
  beat: number;
}

/** Insert only at the measure start or an existing onset in the selected voice. */
export function insertionPositions(document: ScoreDocument, measureId: string, voiceId: string): InsertionPosition[] {
  const measure = document.measures.find(entry => entry.id === measureId);
  if (!measure || !document.voices.some(entry => entry.id === voiceId)) return [];
  const voice = measure.voices.find(entry => entry.id === voiceId);

  const measureBeats = 4 * measure.timeSignature.beats / measure.timeSignature.beatValue
    * (2 - 2 ** -(measure.timeSignature.dots ?? 0));
  const positions = new Map<string, InsertionPosition>();
  positions.set('0/1', { position: { numerator: 0, denominator: 1 }, beat: 0 });
  for (const item of voice?.items ?? []) {
    const position = item.positionFraction;
    if (!position || position.denominator <= 0) continue;
    const beat = 4 * position.numerator / position.denominator;
    if (beat < 0 || beat >= measureBeats) continue;
    positions.set(`${position.numerator}/${position.denominator}`, { position, beat });
  }
  return [...positions.values()].sort((a, b) => a.beat - b.beat);
}

/** Hover and commit resolve to the same exact onset. Midpoint ties choose the earlier one. */
export function insertionPosition(document: ScoreDocument, measureId: string, voiceId: string, rawBeat: number): InsertionPosition | null {
  if (!Number.isFinite(rawBeat)) return null;
  const positions = insertionPositions(document, measureId, voiceId);
  if (!positions.length) return null;
  let nearest = positions[0];
  for (const position of positions.slice(1)) {
    if (Math.abs(position.beat - rawBeat) < Math.abs(nearest.beat - rawBeat)) nearest = position;
  }
  return nearest;
}
