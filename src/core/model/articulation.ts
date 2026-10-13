import type { ArticulationMark } from './score';

// The marks of a carrier and what the backend allows of them: at most one mark of each category (a
// length mark, a loudness mark, an arpeggio). The backend is the judge; this table is only so the
// interface never offers a set it would refuse, and so a new mark replaces the one of its category.

export type ArticulationCategory = 'length' | 'loudness' | 'arpeggio';

/** every mark, in the backend's enum order (the order the list travels in) */
export const ARTICULATION_MARKS: ArticulationMark[] = ['staccato', 'staccatissimo', 'tenuto', 'accent', 'marcato', 'fermata', 'arpeggio_up', 'arpeggio_down'];

export const ARTICULATION_CATEGORY: Record<ArticulationMark, ArticulationCategory> = {
  staccato: 'length',
  staccatissimo: 'length',
  tenuto: 'length',
  fermata: 'length',
  accent: 'loudness',
  marcato: 'loudness',
  arpeggio_up: 'arpeggio',
  arpeggio_down: 'arpeggio',
};

export const ARTICULATION_LABEL: Record<ArticulationMark, string> = {
  staccato: 'Staccato',
  staccatissimo: 'Staccatissimo',
  tenuto: 'Tenuto',
  fermata: 'Fermata',
  accent: 'Accent',
  marcato: 'Marcato',
  arpeggio_up: 'Arpeggio up',
  arpeggio_down: 'Arpeggio down',
};

/** the groups the interface shows, each a choice of at most one mark */
export const ARTICULATION_GROUPS: { category: ArticulationCategory; label: string; marks: ArticulationMark[] }[] = [
  { category: 'length', label: 'Length', marks: ['staccato', 'staccatissimo', 'tenuto', 'fermata'] },
  { category: 'loudness', label: 'Loudness', marks: ['accent', 'marcato'] },
  { category: 'arpeggio', label: 'Arpeggio', marks: ['arpeggio_up', 'arpeggio_down'] },
];

/** the marks after one category is set to `mark` (or cleared with null); the other categories are kept */
export function withMark(current: readonly ArticulationMark[], category: ArticulationCategory, mark: ArticulationMark | null): ArticulationMark[] {
  const kept = current.filter((m) => ARTICULATION_CATEGORY[m] !== category);
  return ARTICULATION_MARKS.filter((m) => m === mark || kept.includes(m));
}

/** known marks, at most one of each category */
export function validMarks(marks: readonly string[]): marks is ArticulationMark[] {
  const seen = new Set<ArticulationCategory>();
  for (const m of marks) {
    const category = ARTICULATION_CATEGORY[m as ArticulationMark];
    if (!category || seen.has(category)) return false;
    seen.add(category);
  }
  return true;
}
