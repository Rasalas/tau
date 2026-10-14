export const CONNECTION_DROPPED_MESSAGE = "The connection to the machine dropped.";
const JOB_DROPPED = "The connection to the machine dropped before the job finished.";
const JOB_RESET = "The link to the machine was reset before the job finished.";

/** A lost reply is not proof that a write failed; it must never be retried blindly. */
export class ConnectionDroppedError extends Error {
  readonly code = "connection-dropped";

  constructor(message = CONNECTION_DROPPED_MESSAGE) {
    super(message);
  }

  static job(): ConnectionDroppedError { return new ConnectionDroppedError(JOB_DROPPED); }
  static reset(): ConnectionDroppedError { return new ConnectionDroppedError(JOB_RESET); }
}

export function isConnectionDropped(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "connection-dropped";
}

/** Legacy notice ports carry only text, sometimes with an action's prefix. */
export function isConnectionDroppedNotice(message: string): boolean {
  return [CONNECTION_DROPPED_MESSAGE, JOB_DROPPED, JOB_RESET].some((text) => message.includes(text));
}
