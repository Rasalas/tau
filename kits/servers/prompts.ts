import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerPrompt, ServerPromptAnswer, ServerPromptRequest } from "./protocol.js";
import { SERVERS_PROMPTS_EVENT } from "./protocol.js";

interface Pending {
  prompt: ServerPrompt;
  settle(answer: ServerPromptAnswer): void;
  fail(error: Error): void;
}

/**
 * Questions the host half puts to the user as Tau dialogs: every client that
 * draws the kit sees the open ones, the first answer wins. The event carries
 * the question only; an answer's value reaches `answer` and nothing keeps it.
 */
export class ServerPrompts {
  private stopped = false;
  private readonly open = new Map<string, Pending>();
  private readonly signals = new AsyncLocalStorage<AbortSignal>();

  constructor(private readonly publish: (event: string, payload: unknown) => void, private readonly available: () => boolean = () => false) {}

  pending(): ServerPrompt[] {
    return [...this.open.values()].map((entry) => entry.prompt);
  }

  /** Answers `cancel` when `signal` aborts or the kit stops. */
  ask(request: ServerPromptRequest, signal?: AbortSignal): Promise<ServerPromptAnswer> {
    signal ??= this.signals.getStore();
    if (signal?.aborted) return Promise.resolve({ action: "cancel" });
    if (this.stopped || !this.available()) return Promise.reject(this.unavailable());
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const onAbort = () => this.answer(id, { action: "cancel" });
      this.open.set(id, {
        prompt: { ...request, id },
        fail: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
        settle: (answer) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(answer);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.changed();
    });
  }

  withSignal<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> { return this.signals.run(signal, run); }

  /** False when the prompt is gone (answered elsewhere, cancelled). */
  answer(id: string, answer: ServerPromptAnswer): boolean {
    const entry = this.open.get(id);
    if (!entry) return false;
    this.open.delete(id);
    entry.settle(answer);
    this.changed();
    return true;
  }

  private unavailable(): HostCommandError {
    return new HostCommandError("Open a Tau desktop or browser window to answer this server question, then retry.");
  }

  surfaceChanged(): void {
    if (this.available()) return;
    for (const [id, entry] of this.open) {
      this.open.delete(id);
      entry.fail(this.unavailable());
    }
    this.changed();
  }

  dispose(): void {
    this.stopped = true;
    for (const id of [...this.open.keys()]) this.answer(id, { action: "cancel" });
  }

  private changed(): void {
    try { this.publish(SERVERS_PROMPTS_EVENT, { prompts: this.pending() }); } catch (cause) {
      for (const [id, entry] of this.open) {
        this.open.delete(id);
        entry.fail(Object.assign(this.unavailable(), { cause }));
      }
    }
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

export function registerServerPromptCommands(context: HostExtensionContext, prompts: ServerPrompts): void {
  context.registerCommand("prompts", () => ({ prompts: prompts.pending() }), { access: "read" });
  context.registerCommand("answer-prompt", (input) => {
    const read = readPromptAnswer(input);
    if (!read) throw new HostCommandError("Not an answer to a server question.");
    return { answered: prompts.answer(read.id, read.answer) };
  }, { audit: { label: "answered a server question" } });
}
