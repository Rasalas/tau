import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  HostCommandError,
  readPersistedJson,
  smallCompletionModel,
  writePersistedJson,
  type HostExtension,
  type HostExtensionContext,
  type HostThread,
} from "tau/host-extension";
import {
  addFiles,
  conversationText,
  excerptSummary,
  filesFromTool,
  handoffRequest,
  mergeBackRequest,
  messagesAfter,
  withoutBlocks,
  writeSummary,
  type ConversationMessage,
  type WrittenSummary,
} from "./handoff.js";
import {
  HANDOFF_EXTENSION_ID,
  HANDOFF_TAG,
  LINEAGE_EVENT,
  MERGE_BACK_TAG,
  NATIVE_FORK_RUNTIMES,
  formatBlock,
  type CreateTransferResult,
  type HandoffStrategy,
  type LineageLink,
  type LineageState,
  type PrepareMergeBackResult,
  type ResolveTransferResult,
} from "./protocol.js";

const STATE_VERSION = 1;
/** A fork nobody sent a first prompt to is forgotten after a week. */
const PENDING_TTL_MS = 7 * 24 * 60 * 60_000;
/** How long a native continuation waits for the runtime's fork to be written. */
const NATIVE_BIND_MS = 60_000;

/**
 * A fork that does not exist yet: where it comes from and the conversation as
 * it stood, so the summary can be written later even when the source thread
 * has been released by then.
 */
interface Transfer {
  id: string;
  sourceThreadId: string;
  sourceTitle: string;
  sourceBackend: string;
  sourceModel?: { provider: string; id: string };
  targetBackend: string;
  cwd: string;
  createdAt: number;
  strategy: HandoffStrategy;
  conversation: string;
  excerpt: string;
  /** The handoff block once written; a refused send reuses it. */
  handoff?: string;
}

/** What the kit keeps per thread: its parent when it is a fork, and what a merge-back needs. */
interface ThreadRecord {
  parentThreadId?: string;
  strategy?: HandoffStrategy;
  sourceBackend?: string;
  targetBackend?: string;
  createdAt?: number;
  files: string[];
  mergedThrough?: string;
  mergedAt?: number;
  /** A merge-back in a parent's composer, committed once a prompt carries it there. */
  pendingMerge?: { parentThreadId: string; through: string };
}

interface Stored extends Record<string, unknown> {
  transfers: Record<string, Transfer>;
  threads: Record<string, ThreadRecord>;
}

export interface HandoffHostOptions {
  now?: () => number;
  newId?: () => string;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";

function required(input: unknown, key: string): string {
  const value = text(record(input)[key]).trim();
  if (!value) throw new HostCommandError(`${key} is required.`);
  return value;
}

function decode(value: unknown): Stored {
  const stored = record(value);
  const transfers: Record<string, Transfer> = {};
  for (const [id, entry] of Object.entries(record(stored.transfers))) {
    const transfer = record(entry);
    if (text(transfer.sourceThreadId) && text(transfer.targetBackend)) transfers[id] = { ...transfer, id } as unknown as Transfer;
  }
  const threads: Record<string, ThreadRecord> = {};
  for (const [id, entry] of Object.entries(record(stored.threads))) {
    const thread = record(entry);
    threads[id] = { ...thread, files: Array.isArray(thread.files) ? thread.files.filter((file): file is string => typeof file === "string") : [] } as ThreadRecord;
  }
  return { transfers, threads };
}

function modelName(model: { provider: string; id: string } | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

function titleOf(thread: HostThread, messages: readonly ConversationMessage[]): string {
  const named = thread.sessionName()?.trim();
  if (named) return named;
  const first = messages.find((message) => message.role === "user" && message.text.trim());
  const words = first ? withoutBlocks(first.text).replace(/\s+/gu, " ").trim() : "";
  return words ? (words.length > 60 ? `${words.slice(0, 57)}…` : words) : "Untitled thread";
}

function whereFrom(title: string, backend: string, model: string | undefined): string {
  return `“${title}” (${[backend, model].filter(Boolean).join(" · ")})`;
}

function summaryBody(written: WrittenSummary): string {
  if (!written.fallback) return written.text;
  return `_No summary was written (${written.fallback}); these are the latest turns._\n\n${written.text}`;
}

/**
 * Handoff Kit's host half. It keeps the links between a thread and the forks
 * it was continued in, writes the handoff and merge-back summaries on a small
 * model, and records which files a fork or a sub-agent changed.
 */
export function createHandoffHostExtension(options: HandoffHostOptions = {}): HostExtension {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? randomUUID;
  return {
    id: HANDOFF_EXTENSION_ID,
    name: "Handoff",
    permissions: ["sessions"],
    async activate(context: HostExtensionContext) {
      const { services } = context;
      const file = join(services.stateDir, "lineage.json");
      const read = await readPersistedJson<Stored>(file, { expectedVersion: STATE_VERSION, decode });
      const state: Stored = read?.data ?? { transfers: {}, threads: {} };
      for (const [id, transfer] of Object.entries(state.transfers)) {
        if (now() - transfer.createdAt > PENDING_TTL_MS) delete state.transfers[id];
      }

      let saving: Promise<void> = Promise.resolve();
      const persist = () => {
        saving = writePersistedJson(file, STATE_VERSION, state)
          .catch((error: unknown) => services.log("handoff.save-failed", error instanceof Error ? error.message : String(error)));
      };
      const lineage = (): LineageState => ({
        links: Object.entries(state.threads).flatMap(([threadId, thread]): LineageLink[] => thread.parentThreadId && thread.strategy
          ? [{
            threadId,
            parentThreadId: thread.parentThreadId,
            strategy: thread.strategy,
            sourceBackend: thread.sourceBackend ?? "pi",
            targetBackend: thread.targetBackend ?? "pi",
            createdAt: thread.createdAt ?? 0,
            ...(thread.mergedAt ? { mergedAt: thread.mergedAt } : {}),
          }]
          : []),
      });
      const changed = () => {
        persist();
        context.emit(LINEAGE_EVENT, lineage());
      };
      const openThread = (threadId: string): HostThread => {
        const thread = services.thread(threadId);
        if (!thread) throw new HostCommandError("That thread is not open any more. Open it again first.");
        if (thread.isStreaming()) throw new HostCommandError("Wait for the thread's turn to end first.");
        return thread;
      };
      const transferOf = (input: unknown): Transfer => {
        const transfer = state.transfers[required(input, "transferId")];
        if (!transfer) throw new HostCommandError("That handoff is gone. Continue from the thread again.");
        return transfer;
      };

      context.registerCommand("state", () => lineage(), { access: "read" });

      context.registerCommand("create-transfer", async (input): Promise<CreateTransferResult> => {
        const target = required(input, "target");
        const thread = openThread(required(input, "threadId"));
        const messages = await thread.transcript();
        if (!messages.some((message) => message.role === "assistant" && message.text.trim())) {
          throw new HostCommandError("There is nothing to hand over yet: the thread has no answer.");
        }
        const native = target === thread.backendKind && NATIVE_FORK_RUNTIMES.includes(target);
        const transfer: Transfer = {
          id: newId(),
          sourceThreadId: thread.sessionId,
          sourceTitle: titleOf(thread, messages),
          sourceBackend: thread.backendKind,
          ...(thread.model ? { sourceModel: { provider: thread.model.provider, id: thread.model.id } } : {}),
          targetBackend: target,
          cwd: thread.cwd,
          createdAt: now(),
          strategy: native ? "native" : "portable",
          // Taken now: the fork continues the thread as it is, not as it may be later.
          conversation: native ? "" : conversationText(messages),
          excerpt: native ? "" : excerptSummary(messages),
        };
        state.transfers[transfer.id] = transfer;
        persist();
        return { transferId: transfer.id, native, sourceTitle: transfer.sourceTitle };
      });

      // Lazy: the summary is written when the fork's first prompt is sent, not when it was made.
      context.registerCommand("resolve-transfer", async (input): Promise<ResolveTransferResult> => {
        const transfer = transferOf(input);
        if (transfer.strategy === "native") throw new HostCommandError("A native fork carries its history itself.");
        if (transfer.handoff) return { context: transfer.handoff };
        const model = await smallCompletionModel(services, transfer.sourceModel);
        const written = await writeSummary(
          (request, chosen) => services.complete(request, chosen),
          model,
          handoffRequest(transfer.conversation, { source: whereFrom(transfer.sourceTitle, transfer.sourceBackend, modelName(transfer.sourceModel)), cwd: transfer.cwd }),
          () => transfer.excerpt,
        );
        services.log("handoff.summary", written.model ?? `excerpt: ${written.fallback ?? ""}`);
        const header = `Continued from ${whereFrom(transfer.sourceTitle, transfer.sourceBackend, modelName(transfer.sourceModel))}. What happened there, as background for the message below:`;
        transfer.handoff = formatBlock(HANDOFF_TAG, header, summaryBody(written));
        persist();
        return { context: transfer.handoff };
      });

      const bind = (transfer: Transfer, threadId: string, backend: string | undefined) => {
        state.threads[threadId] = {
          ...state.threads[threadId],
          parentThreadId: transfer.sourceThreadId,
          strategy: transfer.strategy,
          sourceBackend: transfer.sourceBackend,
          targetBackend: backend ?? transfer.targetBackend,
          createdAt: now(),
          files: state.threads[threadId]?.files ?? [],
        };
        delete state.transfers[transfer.id];
        changed();
      };

      context.registerCommand("bind-transfer", (input) => {
        const transfer = transferOf(input);
        const threadId = required(input, "threadId");
        if (threadId === transfer.sourceThreadId) throw new HostCommandError("A thread cannot continue itself.");
        bind(transfer, threadId, services.thread(threadId)?.backendKind);
        return lineage();
      }, { audit: { label: "continued a handoff", automatic: true } });

      context.registerCommand("cancel-transfer", (input) => {
        const id = required(input, "transferId");
        if (state.transfers[id]) {
          delete state.transfers[id];
          persist();
        }
        return undefined;
      });

      context.registerCommand("prepare-merge-back", async (input): Promise<PrepareMergeBackResult> => {
        const thread = openThread(required(input, "threadId"));
        const known = state.threads[thread.sessionId];
        const parentThreadId = known?.parentThreadId ?? thread.parentThreadId;
        if (!parentThreadId) throw new HostCommandError("This thread was not continued or spawned from another thread.");
        const messages = await thread.transcript();
        // The handoff the fork started from is the parent's own context; it does not go back.
        const delta = messagesAfter(messages, known?.mergedThrough)
          .map((message) => ({ ...message, text: message.role === "user" ? withoutBlocks(message.text) : message.text }))
          .filter((message) => message.text.trim());
        if (!delta.some((message) => message.role === "assistant")) {
          throw new HostCommandError(known?.mergedThrough ? "Nothing new since it was last brought back." : "The thread has no answer to bring back yet.");
        }
        const files = known?.files ?? [];
        const title = titleOf(thread, messages);
        const source = whereFrom(title, thread.backendKind, modelName(thread.model));
        const model = await smallCompletionModel(services, thread.model);
        const written = await writeSummary(
          (request, chosen) => services.complete(request, chosen),
          model,
          mergeBackRequest(conversationText(delta), files, { source, cwd: thread.cwd }),
          () => excerptSummary(delta, files),
        );
        services.log("handoff.merge-back", written.model ?? `excerpt: ${written.fallback ?? ""}`);
        const what = known?.strategy ? "the fork" : "the sub-agent";
        const since = known?.mergedThrough ? "since it was last brought back" : "since it started";
        const header = `Brought back from ${what} ${source}, ${delta.length} messages ${since}:`;
        const through = messages.at(-1)?.id ?? "";
        // Kept here rather than in a window: the parent may be sent to from another client, or after a reload.
        state.threads[thread.sessionId] = { ...known, files, pendingMerge: { parentThreadId, through } };
        persist();
        return { parentThreadId, context: formatBlock(MERGE_BACK_TAG, header, summaryBody(written)), through };
      });

      // A prompt carrying a merge-back reached the parent: the threads brought back to it start after that point next time.
      context.registerCommand("commit-merge-back", (input) => {
        const parentThreadId = required(input, "parentThreadId");
        let committed = false;
        for (const [threadId, thread] of Object.entries(state.threads)) {
          if (thread.pendingMerge?.parentThreadId !== parentThreadId) continue;
          const { pendingMerge, ...rest } = thread;
          state.threads[threadId] = { ...rest, ...(pendingMerge.through ? { mergedThrough: pendingMerge.through } : {}), mergedAt: now() };
          committed = true;
        }
        if (committed) changed();
        return lineage();
      }, { audit: { label: "brought threads back", automatic: true } });

      const disposers = [
        services.registerTurnObserver({
          toolEnded: (sessionId, tool, cwd) => {
            const files = filesFromTool(tool, cwd);
            if (files.length === 0) return;
            const known = state.threads[sessionId];
            // Only threads that can be brought back: this kit's forks and spawned threads.
            if (!known?.parentThreadId && !services.thread(sessionId)?.parentThreadId) return;
            const next = addFiles(known?.files ?? [], files);
            if (known && next.length === known.files.length) return;
            state.threads[sessionId] = { ...known, files: next };
            persist();
          },
        }),
        services.registerThreadLifecycle({
          // A native continuation is the runtime's own fork; this is where its new thread is named.
          afterFork: async (source, target) => {
            const pending = Object.values(state.transfers)
              .filter((transfer) => transfer.strategy === "native" && transfer.sourceThreadId === source.sessionId && now() - transfer.createdAt < NATIVE_BIND_MS)
              .sort((left, right) => right.createdAt - left.createdAt)[0];
            if (pending) bind(pending, target.sessionId, source.backendKind);
          },
          threadDeleted: async (sessionId) => {
            if (!state.threads[sessionId]) return;
            delete state.threads[sessionId];
            changed();
          },
        }),
      ];
      return async () => {
        for (const dispose of disposers) dispose();
        await saving;
      };
    },
  };
}

export default createHandoffHostExtension;
