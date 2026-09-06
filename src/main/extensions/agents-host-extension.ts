import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
  readMaxRunningAgents,
} from "./agents-threads.js";

/** A first prompt that never reaches its thread would leave it "running" forever. */
const SPAWN_ACCEPT_GRACE_MS = 60_000;

const RESULT_LIMIT = 2_000;

/** Panel rows only need a line; the tools get the full excerpt. */
const PANEL_RESULT_LIMIT = 240;

const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};

export function agentsSettingsPath(home = homedir()): string {
  return join(home, ".tau", "agents.json");
}

/** How many children of one thread may run at a time; a bad file is not an error. */
export async function readAgentsSettings(path = agentsSettingsPath()): Promise<number> {
  try {
    return readMaxRunningAgents(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return readMaxRunningAgents(undefined);
  }
}

/** A title the panel can show before the thread has said anything. */
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
    const title = typeof data.title === "string" ? data.title : "Sub-agent";
    const common = { spawnedBy, spawnedAt, projectPath, depth, title };
    if (item.customType === AGENT_PARENT_ENTRY && typeof data.parentThreadId === "string") {
      links.push({ ...common, id: sessionId, threadId: sessionId, parentThreadId: data.parentThreadId });
    } else if (item.customType === AGENT_CHILD_ENTRY && typeof data.threadId === "string") {
      links.push({ ...common, id: data.threadId, threadId: data.threadId, parentThreadId: sessionId });
    }
  }
  return links;
}

function toolResult(value: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value };
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Agents Kit's host entry. A sub-agent is an ordinary Tau thread in the same
 * project with its own runtime and session file (ADR 0012); this kit only
 * gives every runtime the tools to start one, watch it and read its answer.
 */
export function createAgentsHostExtension(options: { settingsPath?: string } = {}): HostExtension {
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
      let publishing: NodeJS.Timeout | undefined;
      // Fifty agents produce bursts of turn events; the panel only needs the
      // state the burst settled on.
      const publish = () => {
        if (publishing) return;
        publishing = setTimeout(() => { publishing = undefined; context.emit(AGENTS_STATE_EVENT, book.state()); }, 30);
        publishing.unref?.();
      };
      void readAgentsSettings(options.settingsPath).then((max) => { book.setMaxRunning(max); publish(); });

      const wake = (id: string) => {
        for (const waiter of waiters.get(id) ?? []) waiter();
      };
      const changed = (idOrThreadId: string, moved: boolean) => {
        const id = book.linkFor(idOrThreadId)?.id;
        if (id) wake(id);
        if (moved) publish();
      };

      const lastAssistantMessage = async (threadId: string | undefined): Promise<string | undefined> => {
        const thread = threadId ? services.thread(threadId) : undefined;
        if (!thread) return undefined;
        const messages = await thread.transcript();
        const text = [...messages].reverse().find((message) => message.role === "assistant" && message.text)?.text;
        return text ? truncate(text, RESULT_LIMIT) : undefined;
      };

      const statusOf = async (id: string) => {
        const facts = book.factsFor(id);
        const link = book.linkFor(id);
        const message = await lastAssistantMessage(link?.threadId) ?? link?.result;
        return {
          threadId: link?.threadId ?? id,
          ...(link?.title ? { title: link.title } : {}),
          status: link?.status ?? "idle",
          turns: facts.turns,
          ...(message ? { lastAssistantMessage: message } : {}),
          ...(facts.pendingToolPrompt ? { pendingToolPrompt: facts.pendingToolPrompt } : {}),
          ...(facts.error ? { error: facts.error } : {}),
        };
      };

      /** A child of this thread, refused by name when it is anything else. */
      const requireChild = (parentThreadId: string, handle: string): AgentThreadLink => {
        const link = book.linkFor(handle);
        if (!link || link.parentThreadId !== parentThreadId) {
          throw new Error(`${handle} is not a thread this one spawned. Use tau_list_threads to see them.`);
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

      const remember = (link: AgentThreadLink) => {
        // The link lives in both session files, so opening either thread after
        // a restart brings it back through `beforeOpen`.
        const data = {
          version: 1,
          spawnedBy: link.spawnedBy,
          spawnedAt: link.spawnedAt,
          projectPath: link.projectPath,
          depth: link.depth,
          title: link.title,
        };
        services.thread(link.threadId)?.appendEntry(AGENT_PARENT_ENTRY, { ...data, parentThreadId: link.parentThreadId });
        services.thread(link.parentThreadId)?.appendEntry(AGENT_CHILD_ENTRY, { ...data, threadId: link.threadId });
      };

      /** Starts what a parent has room for, oldest first; one pump per parent at a time. */
      const pumps = new Map<string, Promise<void>>();
      const prompts = new Map<string, string>();
      const pump = (parentThreadId: string): Promise<void> => {
        const running = pumps.get(parentThreadId);
        if (running) return running;
        const work = (async () => {
          for (;;) {
            const next = book.startable(parentThreadId)[0];
            if (!next) return;
            try {
              const started = await services.sessions.start({
                cwd: next.projectPath,
                prompt: prompts.get(next.id) ?? next.title,
                title: next.title,
                ...(next.model ? { model: parseModel(next.model) } : {}),
              });
              prompts.delete(next.id);
              changed(next.id, book.noteStarted(next.id, started.sessionId, Date.now()));
              remember(book.linkFor(next.id)!);
              services.log("agents.started", `${started.sessionId.slice(0, 8)} · ${next.title}`);
              const guard = setTimeout(() => {
                if (book.factsFor(next.id).spawning) {
                  changed(next.id, book.noteError(next.id, "The first prompt never reached this thread."));
                }
              }, SPAWN_ACCEPT_GRACE_MS);
              guard.unref?.();
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              changed(next.id, book.noteError(next.id, message));
              services.log("agents.start-failed", message);
            }
          }
        })().finally(() => { pumps.delete(parentThreadId); });
        pumps.set(parentThreadId, work);
        return work;
      };

      const spawn = async (parent: RuntimeSessionInfo, input: unknown, inheritedModel: string | undefined) => {
        const request = decodeSpawnRequest(input);
        book.assertCanSpawn(parent.sessionId);
        const projectPath = await resolveProject(request.projectPath, parent.cwd);
        const model = request.model ?? inheritedModel;
        if (model) parseModel(model);
        const id = randomUUID();
        prompts.set(id, request.prompt);
        book.add({
          id,
          parentThreadId: parent.sessionId,
          spawnedBy: "tau_spawn_thread",
          spawnedAt: Date.now(),
          projectPath,
          depth: book.depthOf(parent.sessionId) + 1,
          title: request.title ?? titleFromPrompt(request.prompt),
          ...(model ? { model } : {}),
        }, { queued: true });
        publish();
        // The caller's own agent starts inside this pump when the parent has a
        // slot, so a spawn that is not queued comes back with its thread id.
        await pump(parent.sessionId);
        const link = book.linkFor(id)!;
        return { threadId: link.threadId ?? id, title: link.title, status: link.status };
      };

      /** Resolves when the agent's turn ended, it asked the user something, or it failed. */
      const waitFor = (id: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<"settled" | "timeout"> => {
        const settled = () => {
          const facts = book.factsFor(id);
          const status = book.linkFor(id)?.status;
          return facts.error !== undefined
            || facts.pendingToolPrompt !== undefined
            || (status !== undefined && status !== "running" && status !== "pending");
        };
        if (settled()) return Promise.resolve("settled");
        return new Promise((resolve) => {
          const own = waiters.get(id) ?? new Set<() => void>();
          waiters.set(id, own);
          const finish = (outcome: "settled" | "timeout") => {
            own.delete(check);
            if (own.size === 0) waiters.delete(id);
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
        const threadId = session.sessionId;
        // A dialog a spawned thread opens is answered by the user in that
        // thread; the parent only learns that it is waiting on one.
        pi.on("ui_prompt_start", (event) => { changed(threadId, book.notePrompt(threadId, event.title ?? event.kind)); });
        pi.on("ui_prompt_end", () => { changed(threadId, book.notePrompt(threadId, undefined)); });

        pi.registerTool({
          name: "tau_spawn_thread",
          label: "Spawn thread",
          description: [
            "Start a new Tau thread in this project that works on a task on its own.",
            "It appears in the Agents panel beside this conversation, has its own agent and its own transcript, and runs in the background.",
            `Returns immediately. Spawns beyond the running budget are queued with status "pending" and start as slots free; sub-agents may nest ${MAX_AGENT_DEPTH} levels deep.`,
            "Read an answer with tau_wait_for_thread or tau_get_thread_status.",
          ].join(" "),
          promptSnippet: "tau_spawn_thread: delegate a task to a new background thread in this project",
          parameters: Type.Object({
            prompt: Type.String({ description: "The first message for the new thread. Say what it should do and what to report back." }),
            title: Type.Optional(Type.String({ description: "Title for the Agents panel; derived from the prompt when left out." })),
            model: Type.Optional(Type.String({ description: "Model as provider/model-id; this thread's model when left out." })),
            projectPath: Type.Optional(Type.String({ description: "A project this host already has open; this thread's project when left out." })),
          }),
          execute: async (_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) => {
            const inherited = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
            return toolResult(await spawn(session, params, inherited));
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
            const handle = decodeThreadId(params);
            return toolResult(await statusOf(requireChild(threadId, handle).id));
          },
        });

        pi.registerTool({
          name: "tau_wait_for_thread",
          label: "Wait for thread",
          description: [
            "Wait until a thread spawned from here finishes its current turn, then report its status and final answer.",
            "A queued thread is waited for as well: the wait covers the time it spends pending.",
            "It also returns early when that thread asks the user a question, which only the user can answer in that thread.",
          ].join(" "),
          parameters: Type.Object({
            threadId: Type.String({ description: "Thread id returned by tau_spawn_thread." }),
            timeoutMs: Type.Optional(Type.Number({ description: "How long to wait; 10 minutes by default, 30 minutes at most." })),
          }),
          execute: async (_toolCallId, params, signal) => {
            const handle = decodeThreadId(params);
            const link = requireChild(threadId, handle);
            const timeoutMs = decodeTimeout(params);
            const outcome = await waitFor(link.id, timeoutMs, signal);
            return toolResult({ ...await statusOf(link.id), ...(outcome === "timeout" ? { timedOut: true } : {}) });
          },
        });

        pi.registerTool({
          name: "tau_list_threads",
          label: "List spawned threads",
          description: "List the threads spawned from this one, with what each is doing.",
          parameters: Type.Object({}),
          execute: async () => toolResult({
            threads: book.childrenOf(threadId).map((link) => ({
              threadId: link.threadId ?? link.id,
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
          toolEnded: (sessionId, tool) => { changed(sessionId, book.noteTool(sessionId, tool.name)); },
          ended: async (sessionId, _turnId, outcome) => {
            const link = book.linkFor(sessionId);
            if (!link) return;
            changed(sessionId, book.noteEnded(sessionId, outcome, Date.now()));
            const answer = await lastAssistantMessage(link.threadId);
            if (answer) changed(sessionId, book.noteResult(sessionId, truncate(answer, PANEL_RESULT_LIMIT)));
            // A finished agent frees one of its parent's slots.
            void pump(link.parentThreadId);
          },
          closed: async (sessionId) => { changed(sessionId, book.noteClosed(sessionId)); },
          reset: async (sessionId) => { changed(sessionId, book.noteClosed(sessionId)); },
          // An agent someone is waiting on is not an idle runtime to release.
          pending: (sessionId) => waiters.get(book.linkFor(sessionId)?.id ?? "")?.size ?? 0,
        }),
        services.registerThreadLifecycle({
          beforeOpen: async (session) => {
            const links = linksFromEntries(session.sessionId, session.entries());
            for (const link of links) if (!book.has(link.id)) book.add(link);
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

      return () => {
        if (publishing) clearTimeout(publishing);
        for (const dispose of [...disposers].reverse()) dispose();
      };
    },
  };
}
