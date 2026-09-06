/**
 * A command's answer to bad input or a missing prerequisite: "that path is not
 * a folder", "npm is not installed". It reaches the caller like any error but
 * never counts toward the three failures that deactivate a package — those
 * are for a command that breaks, not for a user who typed the wrong thing.
 */
export class HostCommandError extends Error {
  readonly expected = true;

  constructor(message: string) {
    super(message);
    this.name = "HostCommandError";
  }
}

/** True for a `HostCommandError`, or one revived from a worker's port with its flag intact. */
export function isExpectedCommandError(error: unknown): boolean {
  return error instanceof Error && (error as { expected?: unknown }).expected === true;
}
