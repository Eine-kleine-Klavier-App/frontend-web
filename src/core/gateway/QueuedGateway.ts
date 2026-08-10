import type { EditorGateway } from './EditorGateway';
import type { ScoreDocument } from '@/core/model/score';
import type { Command } from '@/core/commands/command';

/**
 * Serializes every call through an inner gateway: at most one request in
 * flight at a time, applied in call order.
 *
 * Why: the backend keeps one linear undo/redo journal per draft. Two edit
 * requests in flight at once (e.g. a fast double-click, or `load()` racing
 * an in-flight `apply()`) can land out of order or read a stale view.
 * Queuing removes that at the source instead of relying on server-side
 * locking to sort it out. A failed call still lets the queue drain — one
 * rejected edit must not wedge every edit after it.
 */
export class QueuedGateway implements EditorGateway {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly inner: EditorGateway) {}

  load(draftId: string): Promise<ScoreDocument> {
    return this.enqueue(() => this.inner.load(draftId));
  }

  apply(draftId: string, command: Command): Promise<ScoreDocument> {
    return this.enqueue(() => this.inner.apply(draftId, command));
  }

  undo(draftId: string): Promise<ScoreDocument> {
    return this.enqueue(() => this.inner.undo(draftId));
  }

  redo(draftId: string): Promise<ScoreDocument> {
    return this.enqueue(() => this.inner.redo(draftId));
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const result = this.tail.then(op);
    // Always resolves, regardless of whether `op` succeeded — so one failed
    // call still lets the next queued call run. The caller still sees the
    // real result/error through `result`, returned below untouched.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
