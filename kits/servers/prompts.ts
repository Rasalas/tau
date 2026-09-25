import { randomUUID } from "node:crypto";
import type { ServerPrompt, ServerPromptAnswer, ServerPromptRequest } from "./protocol.js";
import { SERVERS_PROMPTS_EVENT } from "./protocol.js";

interface Pending {
  prompt: ServerPrompt;
  settle(answer: ServerPromptAnswer): void;
}

/**
 * Questions the host half puts to the user as Tau dialogs: every client that
 * draws the kit sees the open ones, the first answer wins. The event carries
 * the question only; an answer's value reaches `answer` and nothing keeps it.
 */
export class ServerPrompts {
  private readonly open = new Map<string, Pending>();

  constructor(private readonly publish: (event: string, payload: unknown) => void) {}

  pending(): ServerPrompt[] {
    return [...this.open.values()].map((entry) => entry.prompt);
  }

  /** Answers `cancel` when `signal` aborts or the kit stops. */
  ask(request: ServerPromptRequest, signal?: AbortSignal): Promise<ServerPromptAnswer> {
    if (signal?.aborted) return Promise.resolve({ action: "cancel" });
    return new Promise((resolve) => {
      const id = randomUUID();
      const onAbort = () => this.answer(id, { action: "cancel" });
      this.open.set(id, {
        prompt: { ...request, id },
        settle: (answer) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(answer);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.changed();
    });
  }

  /** False when the prompt is gone (answered elsewhere, cancelled). */
  answer(id: string, answer: ServerPromptAnswer): boolean {
    const entry = this.open.get(id);
    if (!entry) return false;
    this.open.delete(id);
    entry.settle(answer);
    this.changed();
    return true;
  }

  dispose(): void {
    for (const id of [...this.open.keys()]) this.answer(id, { action: "cancel" });
  }

  private changed(): void {
    try { this.publish(SERVERS_PROMPTS_EVENT, { prompts: this.pending() }); } catch { /* delivery is best effort */ }
  }
}

/** An `answer-prompt` input, checked; the value stays out of every error message. */
export function readPromptAnswer(input: unknown): { id: string; answer: ServerPromptAnswer } | undefined {
  const value = (input ?? {}) as { id?: unknown; action?: unknown; value?: unknown };
  if (typeof value.id !== "string") return undefined;
  if (value.action === "cancel" || value.action === "alternative") return { id: value.id, answer: { action: value.action } };
  if (value.action !== "confirm") return undefined;
  if (value.value !== undefined && typeof value.value !== "string") return undefined;
  return { id: value.id, answer: typeof value.value === "string" ? { action: "confirm", value: value.value } : { action: "confirm" } };
}
