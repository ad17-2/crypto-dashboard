/** Best-effort human-readable message for a caught value of unknown shape (e.g. a fetch rejection). */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
