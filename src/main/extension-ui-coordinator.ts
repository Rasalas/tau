import type { ExtensionUiAnswer, ExtensionUiPrompt, ThreadHostEvent } from "../shared/contracts.js";
import { freeTextOption } from "../shared/extension-prompt-options.js";
import { answerImageSaver, answerWithFiles, type SaveAnswerImage } from "./answer-attachments.js";
import type { ThreadRuntime } from "./thread-runtime.js";

const TYPED_ANSWER_TTL_MS = 10_000;

export class ExtensionUiCoordinator {
  private readonly decorators = new Set<(prompt: ExtensionUiPrompt) => void>();
  private readonly pending = new Map<string, { sessionId: string; settle: (answer: ExtensionUiAnswer) => void }>();
  private readonly open = new Map<string, ExtensionUiPrompt>();
  private readonly typedAnswers = new Map<string, { text: string; expiresAt: number }>();

  constructor(
    private readonly emit: (thread: ThreadRuntime | undefined, event: ThreadHostEvent) => void,
    private readonly log: (thread: ThreadRuntime | undefined, label: string, detail?: string) => void,
    private readonly saveImage: SaveAnswerImage = answerImageSaver(),
  ) {}

  addDecorator(decorator: (prompt: ExtensionUiPrompt) => void): () => void {
    this.decorators.add(decorator);
    return () => { this.decorators.delete(decorator); };
  }

  ask(prompt: ExtensionUiPrompt, thread?: ThreadRuntime): Promise<ExtensionUiAnswer> {
    const typed = prompt.kind === "input" ? this.typedAnswers.get(prompt.sessionId) : undefined;
    if (typed) {
      this.typedAnswers.delete(prompt.sessionId);
      if (typed.expiresAt > Date.now()) {
        this.log(thread, "extension-ui.typed", prompt.title.split("\n")[0]);
        return Promise.resolve({ value: typed.text });
      }
    }
    for (const decorate of this.decorators) decorate(prompt);
    return new Promise<ExtensionUiAnswer>((resolve) => {
      let settled = false;
      const settle = (answer: ExtensionUiAnswer) => {
        if (settled) return;
        settled = true;
        this.pending.delete(prompt.id);
        this.open.delete(prompt.id);
        if (timer) clearTimeout(timer);
        this.emit(thread, { type: "extension-ui-resolved", id: prompt.id, sessionId: prompt.sessionId });
        resolve(answer);
      };
      const timer = prompt.expiresAt
        ? setTimeout(() => {
          this.log(thread, "extension-ui.timeout", prompt.title);
          settle({ cancelled: true });
        }, Math.max(0, prompt.expiresAt - Date.now()))
        : undefined;
      timer?.unref?.();
      this.pending.set(prompt.id, { sessionId: prompt.sessionId, settle });
      this.open.set(prompt.id, prompt);
      this.log(thread, "extension-ui.prompt", `${prompt.kind}: ${prompt.title}`);
      this.emit(thread, { type: "extension-ui-prompt", prompt, sessionId: prompt.sessionId });
    });
  }

  answer(id: string, answer: ExtensionUiAnswer): void {
    const prompt = this.open.get(id);
    if ("value" in answer && answer.attachments?.length) {
      // Whoever asked reads text: the files are named in it once they are on disk.
      const sessionId = prompt?.sessionId ?? "thread";
      void answerWithFiles(answer, sessionId, this.saveImage).then((named) => this.answer(id, named), (error: unknown) => {
        this.log(undefined, "extension-ui.attachments.failed", error instanceof Error ? error.message : String(error));
        this.answer(id, { value: answer.value, ...(answer.typed !== undefined ? { typed: answer.typed } : {}) });
      });
      return;
    }
    if (prompt?.kind === "select" && "typed" in answer && answer.typed && "value" in answer) {
      const sentinel = freeTextOption(prompt.options);
      if (sentinel) {
        this.typedAnswers.set(prompt.sessionId, { text: answer.value, expiresAt: Date.now() + TYPED_ANSWER_TTL_MS });
        this.pending.get(id)?.settle({ value: sentinel });
        return;
      }
    }
    this.pending.get(id)?.settle(answer);
  }

  replay(): void {
    for (const prompt of this.open.values()) {
      this.emit(undefined, { type: "extension-ui-prompt", prompt, sessionId: prompt.sessionId });
    }
  }

  hasOpen(sessionId: string): boolean {
    for (const pending of this.pending.values()) if (pending.sessionId === sessionId) return true;
    return false;
  }

  cancelFor(sessionId: string): void {
    const pending = [...this.pending.values()].filter((entry) => entry.sessionId === sessionId);
    pending.forEach((entry) => entry.settle({ cancelled: true }));
  }
}
