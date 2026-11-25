/** A key the keyboard drawing shows beyond what the playing notes do to it. */
export interface KeyMark {
  /** MIDI pitch of the key. */
  pitch: number;
  /** lit: the key stays up and glows; pressed: the key is down and glows. */
  shown: 'lit' | 'pressed';
  /** The light's colour as `#rrggbb`; null is the colour of the voice that plays this pitch. */
  colour: string | null;
}

/**
 * The marks the keyboard drawing is asked to show. Whoever knows which keys matter (a practice mode) sets them,
 * the waterfall reads them on its animation frame, and neither knows the other.
 */
export class KeyMarks {
  private marks: readonly KeyMark[] = [];
  private listeners = new Set<() => void>();

  get(): readonly KeyMark[] {
    return this.marks;
  }

  set(marks: readonly KeyMark[]): void {
    this.marks = marks;
    for (const listener of this.listeners) listener();
  }

  /** Called when the marks change, for a drawing that redraws only on a change. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const keyMarks = new KeyMarks();
