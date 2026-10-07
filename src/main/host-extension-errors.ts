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

export interface HostAuthorizationDetails {
  /** Host-derived principal label, never a value supplied in command input. */
  readonly caller: string;
  readonly target: string;
  readonly command: string;
  /** Stable command capability label used in logs and diagnostics. */
  readonly capability: string;
  readonly reason: string;
}

/** An authorization answer that must not consume the command crash budget. */
export class HostAuthorizationError extends HostCommandError {
  readonly code = "unauthorized";

  constructor(readonly details: HostAuthorizationDetails) {
    super(`Caller ${details.caller} is not allowed to invoke ${details.target}/${details.command}.`);
    this.name = "HostAuthorizationError";
  }
}

/** True for a `HostCommandError`, or one revived from a worker's port with its flag intact. */
export function isExpectedCommandError(error: unknown): boolean {
  return error instanceof Error && (error as { expected?: unknown }).expected === true;
}

/** Diagnostic fields only: never includes command input or arbitrary error properties. */
export interface HostErrorDiagnostic {
  message: string;
  stack?: string;
  name?: string;
  code?: string;
  cause?: HostErrorDiagnostic;
}

/** Bounded so a circular cause cannot break error reporting. */
export function hostErrorDiagnostic(error: unknown, depth = 0): HostErrorDiagnostic {
  if (!(error instanceof Error)) return { message: String(error) };
  const code = (error as { code?: unknown }).code;
  return {
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(error.name !== "Error" ? { name: error.name } : {}),
    ...(typeof code === "string" ? { code } : {}),
    ...(error.cause !== undefined && depth < 4 ? { cause: hostErrorDiagnostic(error.cause, depth + 1) } : {}),
  };
}
