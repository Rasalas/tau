import { Type } from "typebox";
import type { AgentToolResult, ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AGENTS_HOST_EXTENSION_ID,
  AGENTS_STATE_EVENT,
  AGENT_CHILD_ENTRY,
  AGENT_PARENT_ENTRY,
  MAX_AGENT_DEPTH,
  type AgentThreadLink,
} from "../../shared/agents-kit-protocol.js";
import type { HostExtension, HostExtensionContext, RuntimeSessionInfo } from "../host-extensions.js";
import {
  AgentThreadBook,
  decodeSpawnRequest,
  decodeThreadId,
  decodeTimeout,
  parseModel,
} from "./agents-threads.js";

/** A first prompt that never reaches its thread would leave it "running" forever. */
const SPAWN_ACCEPT_GRACE_MS = 60_000;

const LAST_MESSAGE_LIMIT = 2_000;

const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};

/** A title the navigator can show before the thread has said anything. */
export function titleFromPrompt(prompt: string): string {
  const line = prompt.replace(/\s+/gu, " ").trim();
  const sentence = line.split(/(?<=[.!?])\s/u)[0] ?? line;
  const text = sentence.length > 60 ? `${sentence.slice(0, 57)}…` : sentence;
  return text || "Sub-agent";
}

/** Links a session file carries, as `beforeOpen` reads them back after a restart. */
export function linksFromEntries(sessionId: string, entries: readonly unknown[]): Array<Omit<AgentThreadLink, "status">> {
  const links: Array<Omit<AgentThreadLink, "status">> = [];
  for (const entry of entries) {
    const item = record(entry);
    if (item.type !== "custom") continue;
    const data = record(item.data);
    const depth = typeof data.depth === "number" ? data.depth : 1;
    const spawnedBy = typeof data.spawnedBy === "string" ? data.spawnedBy : "tau_spawn_thread";
    const spawnedAt = typeof data.spawnedAt === "number" ? data.spawnedAt : 0;
    const projectPath = typeof data.projectPath === "string" ? data.projectPath : "";
    const title = typeof data.title === "string" ? data.title : undefined;
    if (item.customType === AGENT_PARENT_ENTRY && typeof data.parentThreadId === "string") {
      links.push({ threadId: sessionId, parentThreadId: data.parentThreadId, spawnedBy, spawnedAt, projectPath, depth, ...(title ? { title } : {}) });
    } else if (item.customType === AGENT_CHILD_ENTRY && typeof data.threadId === "string") {
      links.push({ threadId: data.threadId, parentThreadId: sessionId, spawnedBy, spawnedAt, projectPath, depth, ...(title ? { title } : {}) });
    }
  }
  return links;
}

function toolResult(value: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

/**
 * Agents Kit's host entry. A sub-agent is an ordinary Tau thread in the same
 * project with its own runtime and session file (ADR 0012); this kit only
 * gives every runtime the tools to start one, watch it and read its answer.
 */
export function createAgentsHostExtension(): HostExtension {
  return {
    id: AGENTS_HOST_EXTENSION_ID,
    name: "Agents",
    permissions: ["sessions", "runtime:extend"],
    activate(context: HostExtensionContext) {
      const { services } = context;
      const book = new AgentThreadBook((threadId) => {
        const thread = services.thread(threadId);
        return thread ? { streaming: thread.isStreaming(), idle: thread.isIdle() } : undefined;
      });
      const waiters = new Map<string, Set<() => void>>();
      const publish = () => context.emit(AGENTS_STATE_EVENT, book.state());
      const wake = (threadId: string) => {
        for (const waiter of waiters.get(threadId) ?? []) waiter();
      };
      const changed = (threadId: string, moved: boolean) => {
        wake(threadId);
        if (moved) publish();
      };

      const lastAssistantMessage = async (threadId: string): Promise<string | undefined> => {
        const thread = services.thread(threadId);
        if (!thread) return undefined;
        const messages = await thread.transcript();
        const text = [...messages].reverse().find((message) => message.role === "assistant" && message.text)?.text;
        if (!text) return undefined;
        return text.length > LAST_MESSAGE_LIMIT ? `${text.slice(0, LAST_MESSAGE_LIMIT)}…` : text;
      };

      const statusOf = async (threadId: string) => {
        const facts = book.factsFor(threadId);
        const link = book.linkFor(threadId);
        const message = await lastAssistantMessage(threadId);
        return {
          threadId,
          ...(link?.title ? { title: link.title } : {}),
          status: link?.status ?? "idle",
          turns: facts.turns,
          ...(message ? { lastAssistantMessage: message } : {}),
          ...(facts.pendingToolPrompt ? { pendingToolPrompt: facts.pendingToolPrompt } : {}),
          ...(facts.error ? { error: facts.error } : {}),
        };
      };

      /** A child of this thread, refused by name when it is anything else. */
      const requireChild = (parentThreadId: string, threadId: string): AgentThreadLink => {
        const link = book.linkFor(threadId);
        if (!link || link.parentThreadId !== parentThreadId) {
          throw new Error(`${threadId} is not a thread this one spawned. Use tau_list_threads to see them.`);
        }
        return link;
      };

      /** A project the host already knows; a sub-agent cannot open a new folder. */
      const resolveProject = async (requested: string | undefined, parentCwd: string): Promise<string> => {
        if (!requested || requested === parentCwd) return parentCwd;
        const known = await services.sessions.list();
        if (!known.some((session) => session.cwd === requested)) {
          throw new Error(`${requested} is not a project this host has open. Leave projectPath out to use this thread's project.`);
        }
        return requested;
      };

      const remember = (link: Omit<AgentThreadLink, "status">) => {
        book.add(link);
        // The link lives in both session files, so opening either thread after
        // a restart brings it back through `beforeOpen`.
        services.thread(link.threadId)?.appendEntry(AGENT_PARENT_ENTRY, {
          version: 1,
          parentThreadId: link.parentThreadId,
          spawnedBy: link.spawnedBy,
          spawnedAt: link.spawnedAt,
          projectPath: link.projectPath,
          depth: link.depth,
        });
        services.thread(link.parentThreadId)?.appendEntry(AGENT_CHILD_ENTRY, {
          version: 1,
          threadId: link.threadId,
          spawnedBy: link.spawnedBy,
          spawnedAt: link.spawnedAt,
          projectPath: link.projectPath,
          depth: link.depth,
          ...(link.title ? { title: link.title } : {}),
        });
      };

      const spawn = async (parent: RuntimeSessionInfo, input: unknown, model: { provider: string; id: string } | undefined) => {
        const request = decodeSpawnRequest(input);
        book.assertCanSpawn(parent.sessionId);
        const projectPath = await resolveProject(request.projectPath, parent.cwd);
        const title = request.title ?? titleFromPrompt(request.prompt);
        const chosen = request.model ? parseModel(request.model) : model;
        const started = await services.sessions.start({
          cwd: projectPath,
          prompt: request.prompt,
          title,
          ...(chosen ? { model: chosen } : {}),
        });
        remember({
          threadId: started.sessionId,
          parentThreadId: parent.sessionId,
          spawnedBy: "tau_spawn_thread",
          spawnedAt: Date.now(),
          projectPath,
          depth: book.depthOf(parent.sessionId) + 1,
          title,
        });
        setTimeout(() => {
          if (book.factsFor(started.sessionId).spawning) {
            changed(started.sessionId, book.noteError(started.sessionId, "The first prompt never reached this thread."));
          }
        }, SPAWN_ACCEPT_GRACE_MS).unref?.();
        services.log("agents.spawned", `${started.sessionId.slice(0, 8)} · ${title}`);
        publish();
        return { threadId: started.sessionId, title, status: "running" as const };
      };

      /** Resolves when the child's turn ended, it asked the user something, or it failed. */
      const waitFor = (threadId: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<"settled" | "timeout"> => {
        const settled = () => {
          const facts = book.factsFor(threadId);
          const status = book.linkFor(threadId)?.status;
          return facts.error !== undefined || facts.pendingToolPrompt !== undefined || (status !== undefined && status !== "running");
        };
        if (settled()) return Promise.resolve("settled");
        return new Promise((resolve) => {
          const own = waiters.get(threadId) ?? new Set<() => void>();
          waiters.set(threadId, own);
          const finish = (outcome: "settled" | "timeout") => {
            own.delete(check);
            if (own.size === 0) waiters.delete(threadId);
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve(outcome);
          };
          const check = () => { if (settled()) finish("settled"); };
          const onAbort = () => finish("timeout");
          const timer = setTimeout(() => finish("timeout"), timeoutMs);
          own.add(check);
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      };

      const runtimeExtension = (pi: ExtensionAPI, session: RuntimeSessionInfo) => {
        const parentThreadId = session.sessionId;
        // A dialog a spawned thread opens is answered by the user in that
        // thread; the parent only learns that it is waiting on one.
        pi.on("ui_prompt_start", (event) => { changed(parentThreadId, book.notePrompt(parentThreadId, event.title ?? event.kind)); });
        pi.on("ui_prompt_end", () => { changed(parentThreadId, book.notePrompt(parentThreadId, undefined)); });

        pi.registerTool({
          name: "tau_spawn_thread",
          label: "Spawn thread",
          description: [
            "Start a new Tau thread in this project that works on a task on its own.",
            "It appears in the sidebar beside this one, has its own agent and its own transcript, and runs in the background.",
            `Returns immediately. Up to 8 sub-threads may run at once and they may nest ${MAX_AGENT_DEPTH} levels deep.`,
            "Read its answer with tau_wait_for_thread or tau_get_thread_status.",
          ].join(" "),
          promptSnippet: "tau_spawn_thread: delegate a task to a new background thread in this project",
          parameters: Type.Object({
            prompt: Type.String({ description: "The first message for the new thread. Say what it should do and what to report back." }),
            title: Type.Optional(Type.String({ description: "Title for the sidebar; derived from the prompt when left out." })),
            model: Type.Optional(Type.String({ description: "Model as provider/model-id; this thread's model when left out." })),
            projectPath: Type.Optional(Type.String({ description: "A project this host already has open; this thread's project when left out." })),
          }),
          execute: async (_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) => {
            const model = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
            return toolResult(await spawn(session, params, model));
          },
        });

        pi.registerTool({
          name: "tau_get_thread_status",
          label: "Thread status",
          description: "Report what a thread spawned from here is doing right now, and its latest answer.",
          parameters: Type.Object({
            threadId: Type.String({ description: "Thread id returned by tau_spawn_thread." }),
          }),
          execute: async (_toolCallId, params) => {
            const threadId = decodeThreadId(params);
            requireChild(parentThreadId, threadId);
            return toolResult(await statusOf(threadId));
          },
        });

        pi.registerTool({
          name: "tau_wait_for_thread",
          label: "Wait for thread",
          description: [
            "Wait until a thread spawned from here finishes its current turn, then report its status and final answer.",
            "It also returns early when that thread asks the user a question, which only the user can answer in that thread.",
          ].join(" "),
          parameters: Type.Object({
            threadId: Type.String({ description: "Thread id returned by tau_spawn_thread." }),
            timeoutMs: Type.Optional(Type.Number({ description: "How long to wait; 10 minutes by default, 30 minutes at most." })),
          }),
          execute: async (_toolCallId, params, signal) => {
            const threadId = decodeThreadId(params);
            requireChild(parentThreadId, threadId);
            const timeoutMs = decodeTimeout(params);
            const outcome = await waitFor(threadId, timeoutMs, signal);
            return toolResult({ ...await statusOf(threadId), ...(outcome === "timeout" ? { timedOut: true } : {}) });
          },
        });

        pi.registerTool({
          name: "tau_list_threads",
          label: "List spawned threads",
          description: "List the threads spawned from this one, with what each is doing.",
          parameters: Type.Object({}),
          execute: async () => toolResult({
            threads: book.childrenOf(parentThreadId).map((link) => ({
              threadId: link.threadId,
              title: link.title,
              status: link.status,
              spawnedAt: link.spawnedAt,
            })),
          }),
        });
      };

      const disposers = [
        services.registerRuntimeExtension("tau-agents", runtimeExtension),
        services.registerTurnObserver({
          accepted: (sessionId) => { changed(sessionId, book.noteAccepted(sessionId)); },
          ended: async (sessionId, _turnId, outcome) => { changed(sessionId, book.noteEnded(sessionId, outcome)); },
          closed: async (sessionId) => { changed(sessionId, book.noteClosed(sessionId)); },
          reset: async (sessionId) => { changed(sessionId, book.noteClosed(sessionId)); },
          // A thread someone is waiting on is not an idle runtime to release.
          pending: (sessionId) => waiters.get(sessionId)?.size ?? 0,
        }),
        services.registerThreadLifecycle({
          beforeOpen: async (session) => {
            const links = linksFromEntries(session.sessionId, session.entries());
            for (const link of links) if (!book.has(link.threadId)) book.add(link, false);
            if (links.length > 0) publish();
          },
          sweep: async ({ deleted }) => {
            let removed = false;
            for (const session of deleted) removed = book.forget(session.sessionId) || removed;
            if (removed) publish();
          },
        }),
        context.registerCommand("state", () => book.state()),
      ];

      return () => { for (const dispose of [...disposers].reverse()) dispose(); };
    },
  };
}


