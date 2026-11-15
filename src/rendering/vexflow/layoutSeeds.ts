// What a score's spacing settled on, kept between sessions so that opening it again starts from there. Without it a first
// drawing needs several passes (each draws everything, then measures what collides and widens the measures); with it, one.
// Content-addressed: the key is the score's structure and the page width, and a measure's entry is trusted only while the hash
// of what it is drawn from is the same, so a seed never outlives the content it was found for.

export interface LayoutSeed {
  horizontal: Map<string, number>;
  reaches: Map<string, number>;
  inlineWidths: Map<string, number>;
  widthMinimum: Map<string, number>;
  /** the hash of what each measure is drawn from, by measure id */
  signatures: Map<string, number>;
}

const PREFIX = 'layoutSeed:';
const INDEX = `${PREFIX}index`;
/** how many scores' seeds are kept; the least recently written is dropped first */
const KEPT = 6;

export function hashOf(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return hash;
}

export function seedKey(structure: string, width: number): string {
  return `${PREFIX}${hashOf(structure)}:${Math.round(width)}`;
}

const round = (value: number): number => Math.round(value * 100) / 100;
const pairs = (map: Map<string, number>): [string, number][] => [...map].map(([key, value]) => [key, round(value)]);

export function readSeed(key: string): LayoutSeed | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Record<keyof LayoutSeed, [string, number][]>;
    return {
      horizontal: new Map(stored.horizontal),
      reaches: new Map(stored.reaches),
      inlineWidths: new Map(stored.inlineWidths),
      widthMinimum: new Map(stored.widthMinimum),
      signatures: new Map(stored.signatures),
    };
  } catch {
    return null;
  }
}

export function writeSeed(key: string, seed: LayoutSeed): void {
  try {
    localStorage.setItem(key, JSON.stringify({
      horizontal: pairs(seed.horizontal), reaches: pairs(seed.reaches), inlineWidths: pairs(seed.inlineWidths),
      widthMinimum: pairs(seed.widthMinimum), signatures: [...seed.signatures],
    }));
    const kept = (JSON.parse(localStorage.getItem(INDEX) ?? '[]') as string[]).filter((entry) => entry !== key);
    kept.push(key);
    for (const old of kept.splice(0, Math.max(0, kept.length - KEPT))) localStorage.removeItem(old);
    localStorage.setItem(INDEX, JSON.stringify(kept));
  } catch {
    // no storage, or its quota: the next opening simply starts without a seed
  }
}
