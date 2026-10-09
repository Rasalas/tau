import { randomUUID } from "node:crypto";
import type { UiPromptAttachment, UiQueuedMessage, UiQueuedPrompt, UiSkillDraft, UiWake } from "../shared/contracts.js";
import { combineWakes, wakeMessageText } from "../shared/message-turns.js";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";

const VERSION = 1;

/** One message waiting for its thread's turn to end. */
export interface QueuedMessage extends UiQueuedPrompt {
  queuedAt: number;
  /** The thread that sent it, when another thread's agent did. */
  fromThreadId?: string;
  /** Not the user's: a kit woke the thread. Stop drops it; the user's own messages stay. */
  wake?: UiWake;
}

/** What a thread's queue looks like to the thread list; `undefined` when it is empty. */
export interface QueuedMessagesView {
  messages: UiQueuedMessage[];
  held: boolean;
}

export interface QueuedMessagesPort {
  /** Something runs or asks in the thread, so the head waits for it. */
  busy(sessionId: string): boolean;
  /** Resolves once the thread has nothing running; at once for a thread without a runtime. */
  waitForIdle(sessionId: string): Promise<void>;
  /** Sends one message as an ordinary prompt; rejects when the thread refused it. */
  deliver(sessionId: string, message: QueuedMessage): Promise<void>;
  publish(sessionId: string, view: QueuedMessagesView | undefined): void;
  log(label: string, detail?: string): void;
}

export interface QueuedMessagesOptions {
  /** `<userData>/queued-messages.json`; without one the queue only lasts for this run. */
  filePath?: string;
  logger?: PersistedJsonLogger;
}

function decodeAttachment(value: unknown): UiPromptAttachment | undefined {
  const item = value as Partial<UiPromptAttachment> | undefined;
  if (!item || typeof item.name !== "string" || typeof item.mimeType !== "string" || typeof item.size !== "number") return undefined;
  if (item.kind === "image" && typeof item.data === "string") return { kind: "image", name: item.name, mimeType: item.mimeType, data: item.data, size: item.size };
  if (item.kind === "file" && typeof item.path === "string") return { kind: "file", name: item.name, mimeType: item.mimeType, path: item.path, size: item.size };
  return undefined;
}

function decodeSkill(value: unknown): UiSkillDraft | undefined {
  const skill = value as Partial<UiSkillDraft> | undefined;
  return skill?.source === "skill" && typeof skill.name === "string" && typeof skill.visibleText === "string" && typeof skill.command === "string"
    ? { source: "skill", name: skill.name, visibleText: skill.visibleText, command: skill.command }
    : undefined;
}

/** A kit's message as the queue keeps it: a wake carries its mark and is delivered with its line in front. */
export function markWake(text: string, wake: UiWake | undefined): { text: string; wake?: UiWake } {
  if (!wake) return { text };
  const marked = { source: wake.source.slice(0, 32), label: wake.label.replace(/\s+/gu, " ").trim().slice(0, 160) };
  return { text: wakeMessageText(marked, text), wake: marked };
}

function decodeWake(value: unknown): UiWake | undefined {
  const wake = value as Partial<UiWake> | undefined;
  return typeof wake?.source === "string" && typeof wake.label === "string" ? { source: wake.source, label: wake.label } : undefined;
}

function decodeMessage(value: unknown): QueuedMessage | undefined {
  const item = value as Record<string, unknown> | undefined;
  if (!item || typeof item.id !== "string" || typeof item.text !== "string") return undefined;
  const attachments = Array.isArray(item.attachments) ? item.attachments.flatMap((entry) => decodeAttachment(entry) ?? []) : [];
  const skillDraft = decodeSkill(item.skillDraft);
  const wake = decodeWake(item.wake);
  return {
    id: item.id,
    text: item.text,
    attachments,
    queuedAt: typeof item.queuedAt === "number" ? item.queuedAt : 0,
    ...(skillDraft ? { skillDraft } : {}),
    ...(typeof item.fromThreadId === "string" ? { fromThreadId: item.fromThreadId } : {}),
    ...(wake ? { wake } : {}),
  };
}

function decodeQueues(value: unknown): Map<string, QueuedMessage[]> {
  const queues = new Map<string, QueuedMessage[]>();
  const threads = (value as { threads?: unknown } | undefined)?.threads;
  if (!threads || typeof threads !== "object" || Array.isArray(threads)) return queues;
  for (const [sessionId, entries] of Object.entries(threads as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    const messages = entries.flatMap((entry) => decodeMessage(entry) ?? []);
    if (messages.length > 0) queues.set(sessionId, messages);
  }
  return queues;
}

/**
 * The composer's queue, kept by the host: a message sent while a turn runs
 * waits here per thread and leaves as an ordinary prompt when the thread
 * settles. The host owns it so the queue outlives a window, a reload and a
 * host restart; a restored queue is held until the user sends from it.
 */
export class QueuedMessages {
  private readonly queues = new Map<string, QueuedMessage[]>();
  /** Threads whose queue waits for the user, not for the turn. */
  private readonly held = new Set<string>();
  /** Threads whose head is on its way; nothing else leaves until it is accepted. */
  private readonly delivering = new Map<string, QueuedMessage>();
  private pending: Promise<void> = Promise.resolve();
  private frozen = false;

  constructor(private readonly port: QueuedMessagesPort, private readonly options: QueuedMessagesOptions = {}) {}

  /**
   * Reads what the previous run left and holds all of it: the turn those
   * messages waited for did not end the way they expected. `continued` names
   * threads a restart picks back up; their queue follows the continuation.
   */
  async restore(continued: readonly string[] = []): Promise<void> {
    if (!this.options.filePath) return;
    const read = await readPersistedJson(this.options.filePath, {
      expectedVersion: VERSION,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      decode: (value) => decodeQueues(value),
    });
    for (const [sessionId, messages] of read?.data ?? []) {
      this.queues.set(sessionId, [...messages, ...this.list(sessionId)]);
      if (!continued.includes(sessionId)) this.held.add(sessionId);
      this.publish(sessionId);
      this.port.log("queue.restored", `${sessionId.slice(0, 8)} · ${messages.length}${this.held.has(sessionId) ? " held" : ""}`);
      this.settled(sessionId);
    }
  }

  list(sessionId: string): readonly QueuedMessage[] {
    return this.queues.get(sessionId) ?? [];
  }

  view(sessionId: string): QueuedMessagesView | undefined {
    const messages = this.list(sessionId);
    if (messages.length === 0) return undefined;
    return {
      messages: messages.map((message) => ({
        id: message.id,
        text: message.text,
        attachments: message.attachments.length,
        ...(message.fromThreadId ? { fromThreadId: message.fromThreadId } : {}),
        ...(message.wake ? { wake: { ...message.wake } } : {}),
      })),
      held: this.held.has(sessionId),
    };
  }

  isHeld(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  /** Queues a message; a thread with nothing running gets it at once. */
  add(sessionId: string, message: Omit<QueuedMessage, "id" | "queuedAt">): QueuedMessage {
    const queued: QueuedMessage = { ...message, id: `queued-${randomUUID()}`, queuedAt: Date.now() };
    this.write(sessionId, [...this.list(sessionId), queued]);
    void this.pump(sessionId);
    return queued;
  }

  /**
   * Takes messages out without sending them: one by id, or every message of the
   * user's. Wakes stay for `dropWakes`, so a Stop that first hands the user's
   * messages back to the composer still drops and counts them.
   */
  take(sessionId: string, id?: string): QueuedMessage[] {
    const current = this.list(sessionId);
    const taken = id === undefined ? current.filter((message) => !message.wake) : current.filter((message) => message.id === id);
    if (taken.length > 0) this.write(sessionId, current.filter((message) => !taken.includes(message)));
    return [...taken];
  }

  move(sessionId: string, id: string, toIndex: number): void {
    const current = this.list(sessionId);
    const from = current.findIndex((message) => message.id === id);
    if (from < 0) return;
    const target = Math.max(0, Math.min(current.length - 1, toIndex));
    if (target === from) return;
    const next = [...current];
    const [message] = next.splice(from, 1);
    next.splice(target, 0, message!);
    this.write(sessionId, next);
  }

  /**
   * Takes out every wake that waits, synchronously, so no idle pump can send
   * one after a Stop; the user's own messages keep their place.
   */
  dropWakes(sessionId: string): QueuedMessage[] {
    const current = this.list(sessionId);
    const wakes = current.filter((message) => message.wake);
    if (wakes.length > 0) this.write(sessionId, current.filter((message) => !message.wake));
    return wakes;
  }

  /** The queue waits for the user: a stop, a limit or a refused delivery. */
  hold(sessionId: string): void {
    if (this.held.has(sessionId) || this.list(sessionId).length === 0) return;
    this.held.add(sessionId);
    this.publish(sessionId);
  }

  /** The thread runs again, so its queue follows that turn. */
  started(sessionId: string): void {
    if (!this.held.delete(sessionId)) return;
    this.publish(sessionId);
  }

  /** A turn of the thread ended; the head leaves once the thread is idle. */
  settled(sessionId: string): void {
    if (this.frozen || this.list(sessionId).length === 0) return;
    void this.port.waitForIdle(sessionId).then(() => this.pump(sessionId), () => this.pump(sessionId));
  }

  /** A thread that is gone takes its queue with it. */
  forget(sessionId: string): void {
    this.held.delete(sessionId);
    if (this.queues.has(sessionId)) this.write(sessionId, []);
  }

  /** The host is stopping: the aborts of its shutdown must not send anything, and the file keeps what waits. */
  freeze(): void {
    this.frozen = true;
  }

  flush(): Promise<void> {
    return this.pending;
  }

  /** Sends the head when nothing holds the thread back; a refusal puts it back and holds the queue. */
  async pump(sessionId: string): Promise<void> {
    if (this.frozen || this.held.has(sessionId) || this.delivering.has(sessionId)) return;
    const current = this.list(sessionId);
    if (!current[0] || this.port.busy(sessionId)) return;
    // A wake at the head takes every waiting wake with it, as one message.
    const wakes = current[0].wake ? current.filter((message) => message.wake) : [];
    const head: QueuedMessage = wakes.length > 1 ? { ...wakes[0]!, ...combineWakes(wakes.map((wake) => wake.text)), attachments: wakes.flatMap((wake) => wake.attachments) } : current[0];
    const rest = current.filter((message) => message !== current[0] && !(wakes.length > 1 && message.wake));
    this.delivering.set(sessionId, head);
    // Out of the list at once, so no client sends it too; the file keeps it until the thread accepted it.
    this.queues.set(sessionId, rest);
    if (rest.length === 0) this.queues.delete(sessionId);
    this.publish(sessionId);
    try {
      await this.port.deliver(sessionId, head);
      this.delivering.delete(sessionId);
      this.persist();
      this.port.log("queue.delivered", `${sessionId.slice(0, 8)} · ${rest.length} left`);
    } catch (error) {
      // A refused wake is not the user's to resend; its kit wakes the thread again if it still should.
      if (!head.wake) {
        this.queues.set(sessionId, [head, ...this.list(sessionId)]);
        this.held.add(sessionId);
      } else this.persist();
      this.publish(sessionId);
      this.port.log("queue.delivery-failed", `${sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.delivering.delete(sessionId);
    }
  }

  private write(sessionId: string, next: readonly QueuedMessage[]): void {
    if (next.length === 0) {
      this.queues.delete(sessionId);
      this.held.delete(sessionId);
    } else this.queues.set(sessionId, [...next]);
    this.publish(sessionId);
    this.persist();
  }

  private publish(sessionId: string): void {
    this.port.publish(sessionId, this.view(sessionId));
  }

  private persist(): void {
    const path = this.options.filePath;
    if (!path || this.frozen) return;
    // A concurrent add, take or move must retain a head whose admission is
    // still unresolved, even though it is already hidden from the composer.
    const durable = new Map(this.queues);
    for (const [sessionId, head] of this.delivering) durable.set(sessionId, [head, ...this.list(sessionId)]);
    const threads = Object.fromEntries([...durable].filter(([, messages]) => messages.length > 0));
    this.pending = this.pending
      .catch(() => undefined)
      .then(() => writePersistedJson(path, VERSION, { threads }, this.options.logger ? { logger: this.options.logger } : {}))
      .catch(() => undefined);
  }
}
