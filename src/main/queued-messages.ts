import { randomUUID } from "node:crypto";
import type { ClientTurnIdentity, UiPromptAttachment, UiQueuedMessage, UiQueuedPrompt, UiSkillDraft, UiWake } from "../shared/contracts.js";
import { RequestReceipts } from "./request-receipts.js";
import { combineWakes, wakeMessageText } from "../shared/message-turns.js";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";

const VERSION = 1;

/** One message waiting for its thread's turn to end. */
export interface QueuedMessage extends UiQueuedPrompt {
  queuedAt: number;
  identity?: ClientTurnIdentity;
  /** The thread that sent it, when another thread's agent did. */
  fromThreadId?: string;
  /** Not the user's: a kit woke the thread. Stop drops it; the user's own messages stay. */
  wake?: UiWake;
  /** Planned: it leaves at this time (epoch ms), whatever the queue does meanwhile. */
  deliverAt?: number;
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
  /** Throws when the thread may not take another message, before one is queued for it. */
  admit?(sessionId: string): Promise<void>;
  /** Sends one message as an ordinary prompt; rejects when the thread refused it. */
  deliver(sessionId: string, message: QueuedMessage): Promise<void>;
  publish(sessionId: string, view: QueuedMessagesView | undefined): void;
  /** The head's delivery is over, sent or put back. */
  delivered?(sessionId: string): void;
  log(label: string, detail?: string): void;
}

export interface QueuedMessagesOptions {
  /** `<userData>/queued-messages.json`; without one the queue only lasts for this run. */
  filePath?: string;
  logger?: PersistedJsonLogger;
  /** The clock planned messages are due by; tests pass their own. */
  now?(): number;
}

/** setTimeout's longest delay; a later plan rearms when it fires. */
const MAX_TIMER_MS = 2_147_483_647;

const planned = (message: QueuedMessage) => message.deliverAt !== undefined;

function decodeAttachment(value: unknown): UiPromptAttachment | undefined {
  const item = value as Partial<UiPromptAttachment> | undefined;
  if (!item || typeof item.name !== "string" || typeof item.mimeType !== "string" || typeof item.size !== "number") return undefined;
  if (item.kind === "image" && typeof item.data === "string") return { kind: "image", name: item.name, mimeType: item.mimeType, data: item.data, size: item.size };
  if (item.kind === "file" && typeof item.path === "string") return { kind: "file", name: item.name, mimeType: item.mimeType, path: item.path, size: item.size };
  return undefined;
}

function decodeSkill(value: unknown): UiSkillDraft | undefined {
  const skill = value as Partial<UiSkillDraft> | undefined;
  if (skill?.source !== "skill" || typeof skill.name !== "string" || typeof skill.visibleText !== "string" || typeof skill.command !== "string") return undefined;
  const additionalSkills = Array.isArray(skill.additionalSkills)
    ? skill.additionalSkills.flatMap((ref) => typeof ref?.name === "string" && typeof ref.command === "string" ? [{ name: ref.name, command: ref.command }] : [])
    : [];
  return { source: "skill", name: skill.name, visibleText: skill.visibleText, command: skill.command, ...(additionalSkills.length > 0 ? { additionalSkills } : {}) };
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

function decodeIdentity(value: unknown): ClientTurnIdentity | undefined {
  const item = value as Partial<ClientTurnIdentity> | undefined;
  return typeof item?.clientTurnId === "string" && typeof item.clientMessageId === "string"
    ? { clientTurnId: item.clientTurnId, clientMessageId: item.clientMessageId } : undefined;
}

function decodeMessage(value: unknown): QueuedMessage | undefined {
  const item = value as Record<string, unknown> | undefined;
  if (!item || typeof item.id !== "string" || typeof item.text !== "string") return undefined;
  const attachments = Array.isArray(item.attachments) ? item.attachments.flatMap((entry) => decodeAttachment(entry) ?? []) : [];
  const skillDraft = decodeSkill(item.skillDraft);
  const wake = decodeWake(item.wake);
  const identity = decodeIdentity(item.identity);
  return {
    id: item.id,
    text: item.text,
    attachments,
    queuedAt: typeof item.queuedAt === "number" ? item.queuedAt : 0,
    ...(identity ? { identity } : {}),
    ...(skillDraft ? { skillDraft } : {}),
    ...(typeof item.fromThreadId === "string" ? { fromThreadId: item.fromThreadId } : {}),
    ...(wake ? { wake } : {}),
    ...(typeof item.deliverAt === "number" && Number.isFinite(item.deliverAt) && !wake ? { deliverAt: item.deliverAt } : {}),
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
 *
 * A planned message (`deliverAt`) is not part of that line: it leaves at its
 * time, once the thread is idle, even from a held queue, and Stop leaves it in
 * place. One whose time passed while the host was down is not sent late by
 * itself: it becomes an ordinary message of the held queue.
 */
export class QueuedMessages {
  private readonly receipts = new RequestReceipts<QueuedMessage>();
  private readonly queues = new Map<string, QueuedMessage[]>();
  /** Threads whose queue waits for the user, not for the turn. */
  private readonly held = new Set<string>();
  /** Threads whose head is on its way; nothing else leaves until it is accepted. */
  private readonly delivering = new Map<string, QueuedMessage>();
  private pending: Promise<void> = Promise.resolve();
  private restored: boolean;
  private restoring?: Promise<void>;
  private frozen = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly port: QueuedMessagesPort, private readonly options: QueuedMessagesOptions = {}) {
    this.restored = !options.filePath;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Reads what the previous run left and holds all of it: the turn those
   * messages waited for did not end the way they expected. `continued` names
   * threads a restart picks back up; their queue follows the continuation.
   */
  async restore(continued: readonly string[] = []): Promise<void> {
    if (!this.options.filePath) return;
    if (!this.restored) await (this.restoring ??= this.read(this.options.filePath));
    for (const sessionId of continued) {
      this.started(sessionId);
      this.settled(sessionId);
    }
  }

  private async read(path: string): Promise<void> {
    const read = await readPersistedJson(path, {
      expectedVersion: VERSION,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      decode: (value) => decodeQueues(value),
    });
    const now = this.now();
    for (const [sessionId, entries] of read?.data ?? []) {
      // A plan whose time passed while nothing ran is not sent late by itself.
      const messages = entries.map((message) => {
        if (message.deliverAt === undefined || message.deliverAt > now) return message;
        const { deliverAt: _missed, ...rest } = message;
        return rest;
      });
      this.queues.set(sessionId, [...messages, ...this.list(sessionId)]);
      this.held.add(sessionId);
      this.publish(sessionId);
      this.port.log("queue.restored", `${sessionId.slice(0, 8)} · ${messages.length}${this.held.has(sessionId) ? " held" : ""}`);
    }
    this.restored = true;
    this.persist();
    this.arm();
    for (const sessionId of this.queues.keys()) this.settled(sessionId);
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
        ...(message.deliverAt !== undefined ? { deliverAt: message.deliverAt } : {}),
      })),
      held: this.held.has(sessionId),
    };
  }

  isHeld(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  /** A message waits to be sent on its own, or is on its way: the thread's run goes on. */
  continues(sessionId: string): boolean {
    if (this.frozen) return false;
    return this.delivering.has(sessionId) || (!this.held.has(sessionId) && this.list(sessionId).some((message) => !planned(message)));
  }

  /** `add` for a caller that may be refused: a thread whose runtime is off takes no message (ADR 0033). */
  async submit(sessionId: string, message: Omit<QueuedMessage, "id" | "queuedAt">): Promise<QueuedMessage> {
    return this.receipts.run(sessionId, message.identity?.clientMessageId, async () => {
      const existing = message.identity && this.list(sessionId).find((item) => item.identity?.clientMessageId === message.identity!.clientMessageId);
      if (existing) return existing;
      await this.port.admit?.(sessionId);
      return this.add(sessionId, message);
    });
  }

  /** Queues a message; a thread with nothing running gets it at once. */
  add(sessionId: string, message: Omit<QueuedMessage, "id" | "queuedAt">): QueuedMessage {
    const queued: QueuedMessage = { ...message, id: `queued-${message.identity?.clientMessageId ?? randomUUID()}`, queuedAt: Date.now() };
    this.write(sessionId, [...this.list(sessionId), queued]);
    if (planned(queued)) this.arm();
    void this.pump(sessionId);
    return queued;
  }

  /** Plans a waiting message for another time, or with `undefined` puts it back in the line of the queue. */
  reschedule(sessionId: string, id: string, deliverAt: number | undefined): void {
    const current = this.list(sessionId);
    const index = current.findIndex((message) => message.id === id);
    if (index < 0) throw new Error("That message has already left the queue.");
    const { deliverAt: _previous, ...message } = current[index]!;
    const next = [...current];
    next[index] = deliverAt === undefined ? message : { ...message, deliverAt };
    this.write(sessionId, next);
    this.arm();
    void this.pump(sessionId);
  }

  /**
   * Takes messages out without sending them: one by id, or every message of the
   * user's that waits for the turn. Wakes stay for `dropWakes`, so a Stop that
   * first hands the user's messages back to the composer still drops and
   * counts them; planned messages keep their time.
   */
  take(sessionId: string, id?: string): QueuedMessage[] {
    const current = this.list(sessionId);
    const taken = id === undefined ? current.filter((message) => !message.wake && !planned(message)) : current.filter((message) => message.id === id);
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
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Wakes at the next planned message's time and offers every due one to its thread. */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.frozen || !this.restored) return;
    let next: number | undefined;
    for (const messages of this.queues.values()) {
      for (const message of messages) if (message.deliverAt !== undefined && (next === undefined || message.deliverAt < next)) next = message.deliverAt;
    }
    if (next === undefined) return;
    const delay = Math.max(0, next - this.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const now = this.now();
      for (const [sessionId, messages] of this.queues) {
        if (messages.some((message) => message.deliverAt !== undefined && message.deliverAt <= now)) this.settled(sessionId);
      }
      this.arm();
    }, Math.min(delay, MAX_TIMER_MS));
    this.timer.unref?.();
  }

  /**
   * What leaves next: a planned message whose time has come, the earliest
   * first, even from a held queue; else, unless the queue is held, the first
   * message that waits for the turn.
   */
  private headOf(sessionId: string): QueuedMessage | undefined {
    const current = this.list(sessionId);
    const now = this.now();
    const due = current
      .filter((message) => message.deliverAt !== undefined && message.deliverAt <= now)
      .sort((a, b) => a.deliverAt! - b.deliverAt!)[0];
    if (due) return due;
    return this.held.has(sessionId) ? undefined : current.find((message) => !planned(message));
  }

  flush(): Promise<void> {
    return this.pending;
  }

  /** Sends the head when nothing holds the thread back; a refusal puts it back and holds the queue. */
  async pump(sessionId: string): Promise<void> {
    if (!this.restored || this.frozen || this.delivering.has(sessionId)) return;
    const current = this.list(sessionId);
    const first = this.headOf(sessionId);
    if (!first || this.port.busy(sessionId)) return;
    // A wake at the head takes every waiting wake with it, as one message.
    const wakes = first.wake ? current.filter((message) => message.wake) : [];
    const head: QueuedMessage = wakes.length > 1 ? { ...wakes[0]!, ...combineWakes(wakes.map((wake) => wake.text)), attachments: wakes.flatMap((wake) => wake.attachments) } : first;
    const rest = current.filter((message) => message !== first && !(wakes.length > 1 && message.wake));
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
        // A refused plan waits with the held queue; kept due, it would be offered again at once.
        const { deliverAt: _due, ...back } = head;
        this.queues.set(sessionId, [back, ...this.list(sessionId)]);
        this.held.add(sessionId);
      } else this.persist();
      this.publish(sessionId);
      this.port.log("queue.delivery-failed", `${sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.delivering.delete(sessionId);
      this.port.delivered?.(sessionId);
      // A fast turn can settle while its delivery still owns the pump. Retry
      // after releasing it; busy/held/frozen still decide whether the head leaves.
      void this.pump(sessionId);
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
    if (!path || !this.restored || this.frozen) return;
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
