/**
 * Which process owns the Pi runtime. Tau's host marks itself so extensions that
 * exist to expose a Pi TUI session *to* Tau can stand down: loading them inside
 * Tau's own runtime would duplicate their workspace machinery against the
 * host's, and the two would then queue behind each other for the same lease.
 */
const TAU_HOST_RUNTIME = "TAU_HOST_RUNTIME";

export function markTauHostRuntime(): void {
  process.env[TAU_HOST_RUNTIME] = "1";
}

export function tauOwnsRuntime(): boolean {
  return process.env[TAU_HOST_RUNTIME] === "1";
}
