import { join } from "node:path";
import {
  HostCommandError,
  readPersistedJson,
  smallCompletionModel,
  writePersistedJson,
  type HostExtensionContext,
  type HostThread,
} from "tau/host-extension";
import { BTW_SYSTEM, btwPrompt, fitLines, linesFromEntries, linesFromMessages } from "./btw-context.js";
import { BTW_EVENT, type BtwAskInput, type BtwChat, type BtwGone } from "./protocol.js";

const STATE_VERSION = 1;
/** Answers that run at once; one more waits for the user rather than queueing a bill. */
const MAX_WORKING = 4;
/** What a thread keeps: the oldest finished question goes first. */
const MAX_PER_THREAD = 20;
const MAX_QUESTION_CHARS = 4_000;
const ANSWER_TOKENS = 4_096;
const ANSWER_TIMEOUT_MS = 180_000;

export interface SideQuestionOptions {
  now: () => number;
  newId: () => string;
  /** How often a streaming answer is pushed to the windows, in ms; 0 pushes every piece. */
  pushEveryMs?: number;
}

interface Stored extends Record<string, unknown> {
  chats: Record<string, BtwChat>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function decode(value: unknown): Stored {
  const chats: Record<string, BtwChat> = {};
  for (const [id, entry] of Object.entries(isRecord(value) && isRecord(value.chats) ? value.chats : {})) {
    if (isRecord(entry) && typeof entry.threadId === "string" && typeof entry.question === "string") {
      chats[id] = { ...entry, id, answer: typeof entry.answer === "string" ? entry.answer : "" } as unknown as BtwChat;
    }
  }
  return { chats };
}

/** The last entry id of a journal: where a fork continues the thread. */
function leafOf(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const id = (entries[index] as { id?: unknown } | undefined)?.id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

function journalOf(thread: HostThread): readonly unknown[] {
  try {
    return thread.entries();
  } catch {
    return [];
  }
}

/**
 * Side questions (`/btw`): a question about a thread's conversation, answered
 * by a model that gets the conversation as text and no tools, and written
 * nowhere but here. The thread is never touched, so it may be mid-turn.
 */
export class SideQuestions {
  private chats = new Map<string, BtwChat>();
  private readonly running = new Map<string, AbortController>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private saving: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(private readonly context: HostExtensionContext, private readonly options: SideQuestionOptions) {
    this.file = join(context.services.stateDir, "side-questions.json");
  }

  async open(): Promise<void> {
    const read = await readPersistedJson<Stored>(this.file, { expectedVersion: STATE_VERSION, decode });
    for (const chat of Object.values(read?.data.chats ?? {})) {
      // The process that was answering is gone.
      if (chat.status === "working") Object.assign(chat, { status: "failed", error: "Tau closed before this was answered." });
      this.chats.set(chat.id, chat);
    }
    this.context.registerCommand("btw-ask", (input) => this.ask(input as BtwAskInput));
    this.context.registerCommand("btw-get", (input) => { const chat = this.chats.get(this.id(input)); return chat && { ...chat }; }, { access: "read" });
    this.context.registerCommand("btw-forget", (input) => { this.forget(this.id(input)); });
  }

  async close(): Promise<void> {
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.saving;
  }

  /** The thread is gone for good. */
  forgetThread(threadId: string): void {
    for (const chat of [...this.chats.values()]) if (chat.threadId === threadId) this.forget(chat.id);
  }

  forget(id: string): void {
    this.running.get(id)?.abort();
    this.running.delete(id);
    if (!this.chats.delete(id)) return;
    this.persist();
    this.context.emit(BTW_EVENT, { id, gone: true } satisfies BtwGone);
  }

  private id(input: unknown): string {
    const id = isRecord(input) && typeof input.chatId === "string" ? input.chatId.trim() : "";
    if (!id) throw new HostCommandError("chatId is required.");
    return id;
  }

  private persist(): void {
    const chats = Object.fromEntries(this.chats);
    this.saving = writePersistedJson(this.file, STATE_VERSION, { chats })
      .catch((error: unknown) => this.context.services.log("btw.save-failed", error instanceof Error ? error.message : String(error)));
  }

  private push(chat: BtwChat, now = false): void {
    const wait = this.options.pushEveryMs ?? 80;
    if (now || wait <= 0) {
      clearTimeout(this.timers.get(chat.id));
      this.timers.delete(chat.id);
      this.context.emit(BTW_EVENT, { ...chat });
      return;
    }
    if (this.timers.has(chat.id)) return;
    this.timers.set(chat.id, setTimeout(() => {
      this.timers.delete(chat.id);
      if (this.chats.has(chat.id)) this.context.emit(BTW_EVENT, { ...chat });
    }, wait));
  }

  private async ask(input: BtwAskInput): Promise<BtwChat> {
    const question = (isRecord(input) && typeof input.question === "string" ? input.question : "").trim();
    if (!question) throw new HostCommandError("Add a question after /btw.");
    if (question.length > MAX_QUESTION_CHARS) throw new HostCommandError(`Keep the question under ${MAX_QUESTION_CHARS} characters.`);
    const threadId = isRecord(input) && typeof input.threadId === "string" ? input.threadId : "";
    const thread = this.context.services.thread(threadId);
    if (!threadId || !thread) throw new HostCommandError("That thread is not open any more. Open it again first.");
    if (this.running.size >= MAX_WORKING) throw new HostCommandError("Wait for an earlier side question to be answered first.");
    const now = this.options.now();
    const again = typeof input.chatId === "string" ? this.chats.get(input.chatId) : undefined;
    if (again && (again.threadId !== threadId || this.running.has(again.id))) throw new HostCommandError("That side question cannot be asked again now.");
    const journal = journalOf(thread);
    const entryId = leafOf(journal);
    const chat: BtwChat = {
      ...(again ?? {}),
      id: again?.id ?? this.options.newId(),
      threadId,
      question,
      answer: "",
      status: "working",
      backend: thread.backendKind,
      createdAt: again?.createdAt ?? now,
      updatedAt: now,
    } as BtwChat;
    delete chat.error;
    delete chat.model;
    if (entryId) chat.entryId = entryId; else delete chat.entryId;
    this.chats.set(chat.id, chat);
    this.trim(threadId, chat.id);
    this.persist();
    this.push(chat, true);
    const controller = new AbortController();
    this.running.set(chat.id, controller);
    const snapshot = { ...chat };
    void this.answer(chat, thread, journal, controller);
    return snapshot;
  }

  private trim(threadId: string, keep: string): void {
    const mine = [...this.chats.values()].filter((chat) => chat.threadId === threadId).sort((left, right) => left.createdAt - right.createdAt);
    for (const chat of mine) {
      if (mine.length <= MAX_PER_THREAD) break;
      if (chat.id === keep || chat.status === "working") continue;
      this.chats.delete(chat.id);
      this.context.emit(BTW_EVENT, { id: chat.id, gone: true } satisfies BtwGone);
      mine.splice(mine.indexOf(chat), 1);
    }
  }

  private async answer(chat: BtwChat, thread: HostThread, journal: readonly unknown[], controller: AbortController): Promise<void> {
    const { services } = this.context;
    try {
      let lines = linesFromEntries(journal);
      if (lines.length === 0) lines = linesFromMessages(await thread.transcript());
      const request = {
        system: BTW_SYSTEM,
        prompt: btwPrompt({ context: fitLines(lines), question: chat.question, cwd: thread.cwd, working: thread.isStreaming() }),
        maxTokens: ANSWER_TOKENS,
        timeoutMs: ANSWER_TIMEOUT_MS,
        signal: controller.signal,
        onText: (delta: string) => {
          if (!this.running.has(chat.id)) return;
          chat.answer += delta;
          chat.updatedAt = this.options.now();
          this.push(chat);
        },
      };
      const text = await this.complete(thread, request, chat);
      if (!this.running.has(chat.id)) return;
      if (!text.trim()) throw new Error("The model sent no answer.");
      chat.answer = text;
      chat.status = "done";
    } catch (error) {
      if (!this.running.has(chat.id)) return;
      chat.status = "failed";
      chat.error = error instanceof Error ? error.message : String(error);
      services.log("btw.failed", chat.error);
    }
    this.running.delete(chat.id);
    chat.updatedAt = this.options.now();
    this.persist();
    this.push(chat, true);
  }

  /** The thread's own model through its runtime's login; a runtime that cannot complete uses a small model of the user's. */
  private async complete(thread: HostThread, request: Parameters<HostThread["complete"]>[2], chat: BtwChat): Promise<string> {
    const { services } = this.context;
    if (thread.model) {
      try {
        const text = await thread.complete(thread.model.provider, thread.model.id, request);
        chat.model = `${thread.model.provider}/${thread.model.id}`;
        return text;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "UnsupportedOperationError") throw error;
      }
    }
    const model = await smallCompletionModel(services, thread.model, { elsePrefer: true });
    if (model) chat.model = `${model.provider}/${model.id}`;
    return services.complete(request, model);
  }
}
