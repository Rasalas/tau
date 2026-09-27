import type { ExtensionUiAnswer, ExtensionUiPrompt, HostEvent, ThreadHostEvent } from "../shared/contracts.js";
import { freeTextOption } from "../shared/extension-prompt-options.js";
import { answerImageSaver, answerWithFiles, type SaveAnswerImage } from "./answer-attachments.js";
import type { ThreadRuntime } from "./thread-runtime.js";

const TYPED_ANSWER_TTL_MS = 10_000;

/** Sees a question before it goes out; a function it returns runs once the question is answered, cancelled or expires. */
export type UiPromptDecorator = (prompt: ExtensionUiPrompt) => void | (() => void);

/**
 * The host's record of the questions that wait for the user. Every client
 * follows it: the prompt and resolved events keep them current, and
 * `replay()` hands a (re)connecting client the whole open set.
 */
export class ExtensionUiCoordinator {
  private readonly decorators = new Set<UiPromptDecorator>();
  private readonly pending = new Map<string, { sessionId: string; settle: (answer: ExtensionUiAnswer) => void }>();
  private readonly open = new Map<string, ExtensionUiPrompt>();
  /** Questions a runtime asks and answers elsewhere (an attached Pi terminal); shown, never awaited here. */
  private readonly elsewhere = new Map<string, ExtensionUiPrompt>();
  private readonly typedAnswers = new Map<string, { text: string; expiresAt: number }>();

  constructor(
    private readonly emit: (thread: ThreadRuntime | undefined, event: ThreadHostEvent) => void,
    private readonly log: (thread: ThreadRuntime | undefined, label: string, detail?: string) => void,
    private readonly saveImage: SaveAnswerImage = answerImageSaver(),
  ) {}

  addDecorator(decorator: UiPromptDecorator): () => void {
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
    const afterwards: Array<() => void> = [];
    for (const decorate of this.decorators) {
      const done = decorate(prompt);
      if (typeof done === "function") afterwards.push(done);
    }
    return new Promise<ExtensionUiAnswer>((resolve) => {
      let settled = false;
      const settle = (answer: ExtensionUiAnswer) => {
        if (settled) return;
        settled = true;
        this.pending.delete(prompt.id);
        this.open.delete(prompt.id);
        if (timer) clearTimeout(timer);
        this.emit(thread, { type: "extension-ui-resolved", id: prompt.id, sessionId: prompt.sessionId });
        for (const done of afterwards) {
          try { done(); } catch (error) { this.log(thread, "extension-ui.decorator-failed", error instanceof Error ? error.message : String(error)); }
        }
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

  /** Re-announces every open question and returns them; a client drops what it holds beyond these. */
  replay(): ExtensionUiPrompt[] {
    const prompts = [...this.open.values(), ...this.elsewhere.values()];
    for (const prompt of prompts) {
      this.emit(undefined, { type: "extension-ui-prompt", prompt, sessionId: prompt.sessionId });
    }
    return prompts;
  }

  /** Follows questions other parts of the host publish themselves, so `replay` lists them too. */
  observe(event: HostEvent): void {
    if (event.type === "extension-ui-prompt" && !this.open.has(event.prompt.id)) this.elsewhere.set(event.prompt.id, event.prompt);
    else if (event.type === "extension-ui-resolved") this.elsewhere.delete(event.id);
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
