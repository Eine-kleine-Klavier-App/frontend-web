// Deterministic warm plate tint per composer — the engraved-cover signature
// (docs/browse-redesign.md). Seeded by composer so a composer's pieces share a family tint, and
// the value NEVER claims meaning (genre is mock). 6 warm washes defined as --plate-0..5 tokens.
const PLATE_COUNT = 6;

export function plateTintIndex(seed: string | null): number {
  const s = seed ?? 'unknown';
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % PLATE_COUNT;
}

export function plateTintClass(seed: string | null): string {
  return `plate-tint-${plateTintIndex(seed)}`;
}
