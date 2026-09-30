/** The message of a thrown error, or `fallback` when what was thrown carries none. */
export function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
