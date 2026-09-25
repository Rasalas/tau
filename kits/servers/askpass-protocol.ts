// Shared by both halves; no imports, so any side may read it.

/** What ssh asked through askpass, as Tau reads the prompt. */
export type AskpassKind = "password" | "passphrase" | "otp" | "host-key" | "confirm" | "other";

/** A question the desktop half draws as a dialog; never carries a secret. */
export interface AskpassQuestion {
  id: string;
  kind: AskpassKind;
  /** Who asks: the target's name, else `user@host`. */
  target: string;
  /** ssh's own prompt text. */
  prompt: string;
  /** `host-key`: `SHA256:…`. */
  fingerprint?: string;
  keyType?: string;
  /** `host-key`: the host as ssh names it (`[127.0.0.1]:2222`). */
  host?: string;
  /** `passphrase`: the key file. */
  keyPath?: string;
  /** 2 and up: the answer before this one was wrong. */
  attempt: number;
  /** Epoch ms after which the question is answered as cancelled. */
  expiresAt: number;
}

/** Host event: a question is waiting. */
export const ASKPASS_QUESTION_EVENT = "askpass-question";
/** Host event `{ id }`: answered, cancelled or expired; every window closes it. */
export const ASKPASS_DONE_EVENT = "askpass-done";
/** Host command `{ id, answer }` or `{ id, cancel: true }`. */
export const ASKPASS_ANSWER_COMMAND = "askpass-answer";
/** Host command: the questions waiting now, for a window that opened late. */
export const ASKPASS_PENDING_COMMAND = "askpass-pending";

/** Whether the answer is typed hidden. */
export const isSecretKind = (kind: AskpassKind) => kind === "password" || kind === "passphrase" || kind === "otp" || kind === "other";

export function decodeAskpassQuestion(value: unknown): AskpassQuestion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const question = value as Partial<AskpassQuestion>;
  if (typeof question.id !== "string" || typeof question.kind !== "string" || typeof question.prompt !== "string" || typeof question.target !== "string") return undefined;
  return question as AskpassQuestion;
}
