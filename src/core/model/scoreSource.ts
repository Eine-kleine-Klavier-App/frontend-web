/** The saved document being read or the working copy being edited. */
export type ScoreSource = { kind: 'saved'; id: string } | { kind: 'draft'; id: string };
