export interface DirectedPlacement { direction: 1 | -1 }
/** a stem as the user set it: a direction and the length as a factor of the automatic one (1 = automatic) */
export interface StemPlacement extends Partial<DirectedPlacement> { lengthFactor: number }
export type ReferencePoint = 'body' | 'stem_tip' | 'lower_edge' | 'height';
export interface PresentationTarget { entity_id: string; reference: ReferencePoint }
export interface Presentation {
  vertical: (PresentationTarget & { offset: number })[];
  endpoints: (PresentationTarget & { left: number; right: number })[];
  directions: (PresentationTarget & { direction: 'up' | 'down' })[];
  horizontal: (PresentationTarget & { offset: number })[];
  horizontal_endpoints: (PresentationTarget & { left: number; right: number })[];
}
export interface PlacementCapabilities extends PresentationTarget {
  vertical: boolean; endpoints: boolean; directed: boolean; horizontal: boolean; horizontal_endpoints: boolean;
}
export type PresentationChange =
  | { kind: 'vertical'; target: PresentationTarget; offset: number | null }
  | { kind: 'endpoints'; target: PresentationTarget; offsets: { left: number; right: number } | null }
  | { kind: 'direction'; target: PresentationTarget; direction: 'up' | 'down' | null }
  | { kind: 'horizontal'; target: PresentationTarget; offset: number | null }
  | { kind: 'horizontal_endpoints'; target: PresentationTarget; offsets: { left: number; right: number } | null };
export const emptyPresentation = (): Presentation => ({ vertical: [], endpoints: [], directions: [], horizontal: [], horizontal_endpoints: [] });
export function stemPlacements(presentation: Presentation): Record<string, StemPlacement> {
  const result: Record<string, StemPlacement> = {};
  for (const value of presentation.directions) if (value.reference === 'stem_tip')
    result[value.entity_id] = { direction: value.direction === 'up' ? 1 : -1, lengthFactor: 1 };
  for (const value of presentation.vertical) if (value.reference === 'stem_tip')
    result[value.entity_id] = { ...result[value.entity_id], lengthFactor: value.offset };
  return result;
}
/** the stored distance of a context's mark from its staff as a factor of the automatic one (1 = automatic) */
export const bodyFactor = (presentation: Presentation, id: string): number =>
  presentation.vertical.find(value => value.entity_id === id && value.reference === 'body')?.offset ?? 1;
/** how far a rest stands from its automatic place, as a fraction of the height of its staff (0 = automatic) */
export const bodyFraction = (presentation: Presentation, id: string): number =>
  presentation.vertical.find(value => value.entity_id === id && value.reference === 'body')?.offset ?? 0;
/** the stored arch height of a slur as a factor of the arch it has of itself (1 = as automatic); null while the arch is automatic */
export const slurHeight = (presentation: Presentation, id: string): number | null =>
  presentation.vertical.find(value => value.entity_id === id && value.reference === 'height')?.offset ?? null;
