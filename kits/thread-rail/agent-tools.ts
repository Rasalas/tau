import { Type } from "typebox";
import { HostCommandError, type HostMcpTool, type RuntimeSessionInfo } from "tau/host-extension";
import type { UiSession } from "tau";
import { DIRECTORY_LIMIT, DIRECTORY_MAX, describeThread, selectThreads, type DirectoryRequest } from "./directory.js";
import { isSnoozed, settlePatch, snoozePatch, unsettlePatch, WAKE_PATCH } from "./meta.js";
import type { RailState, ThreadMetaPatch } from "./protocol.js";

/** What the tools need of the host half; `host.ts` fills it from its own state. */
export interface AgentToolPorts {
  now(): number;
  /** The rail's state for this host's threads. */
  state(): RailState;
  /** Every thread of this host with its title, from the host's index. */
  threads(): Promise<readonly UiSession[]>;
  isRunning(threadId: string): boolean;
  /** Review Kit's stored request links, for the named threads or those matching `query`; empty without it. */
  requests(input: { threadIds?: readonly string[]; query?: string }): Promise<Record<string, DirectoryRequest[]>>;
  apply(threadId: string, patch: ThreadMetaPatch): Promise<void>;
  /** Keeps the change for the end of the thread's run (`host.ts` applies it there). */
  defer(threadId: string, change: DeferredChange): void;
  forgetDeferred(threadId: string): void;
}

export type DeferredChange = { action: "settle" } | { action: "snooze"; until: number };

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

const STATES = ["active", "pinned", "snoozed", "settled", "archived"] as const;

/** The section for the endpoint's instructions and Pi's system prompt: how to mention and organize threads. */
export const DIRECTORY_INSTRUCTIONS = [
  "<thread_directory>",
  "tau_find_threads lists this host's threads with the rail state each is in (settled, snoozed until when, pinned, running) and a ready-made Markdown `link`.",
  "To mention another thread, paste its `link` as given: it is the thread's id and shows its current title. Do not retype a title as a link.",
  "tau_thread_organize settles, snoozes, unsettles or wakes a thread. On your own thread settle and snooze take effect when your turn ends successfully; settle only when the work is finished and the user has no open question.",
  "</thread_directory>",
].join("\n");

/**
 * The agent's view of the thread list and its two verbs: `tau_find_threads` (state,
 * snooze, filters, linked requests) and `tau_thread_organize`. A change to a running
 * thread, the caller's own included, waits for the end of its run.
 */
export function agentTools(ports: AgentToolPorts, session: RuntimeSessionInfo): HostMcpTool[] {
  const own = session.sessionId;
  return [
    {
      name: "tau_find_threads",
      label: "Find threads",
      description: "List the threads on this host with their rail state (settled, snoozed until when, pinned, running), the pull requests they link, and a Markdown link to paste. Filter by words (title, project, branch, #123 or owner/repo#123), state, settled or snoozed. Archived threads and agents' child threads are left out unless asked for.",
      promptSnippet: "tau_find_threads: list threads with snooze and settle state and links",
      annotations: { readOnlyHint: true },
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Words of the title, project or branch, a request number (#123, owner/repo#123) or URL." })),
        state: Type.Optional(Type.Union(STATES.map((state) => Type.Literal(state)), { description: "Only threads in this part of the rail; archived threads show only when asked for." })),
        settled: Type.Optional(Type.Boolean({ description: "true for settled threads only, false for those not settled." })),
        snoozed: Type.Optional(Type.Boolean({ description: "true for snoozed threads only, false for those awake." })),
        includeSubagents: Type.Optional(Type.Boolean({ description: "Include threads that agents started for their parents." })),
        limit: Type.Optional(Type.Number({ description: `At most this many, newest first (${DIRECTORY_LIMIT} by default, ${DIRECTORY_MAX} at most).` })),
      }),
      execute: async (_toolCallId: string, params: unknown) => {
        const input = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
        const now = ports.now();
        const state = ports.state();
        const query = typeof input.query === "string" ? input.query.trim() : "";
        const [sessions, matches] = await Promise.all([ports.threads(), query ? ports.requests({ query }) : Promise.resolve({})]);
        const described = sessions
          .filter((thread) => !thread.machine && thread.backendKind !== "machine")
          .map((thread) => describeThread(thread, state.threads[thread.id], { now, running: ports.isRunning(thread.id), current: thread.id === own }));
        const wanted = typeof input.state === "string" && (STATES as readonly string[]).includes(input.state) ? input.state as (typeof STATES)[number] : undefined;
        const picked = selectThreads(described, {
          query,
          ...(wanted ? { state: wanted } : {}),
          ...(typeof input.settled === "boolean" ? { settled: input.settled } : {}),
          ...(typeof input.snoozed === "boolean" ? { snoozed: input.snoozed } : {}),
          includeSubagents: input.includeSubagents === true,
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
        }, new Set(Object.keys(matches)));
        const links = picked.threads.length > 0 ? await ports.requests({ threadIds: picked.threads.map((thread) => thread.threadId) }) : {};
        return toolResult({
          total: picked.total,
          threads: picked.threads.map((thread) => links[thread.threadId] ? { ...thread, pullRequests: links[thread.threadId] } : thread),
        });
      },
    },
    {
      name: "tau_thread_organize",
      label: "Organize thread",
      description: "Settle, unsettle, snooze or wake a thread in the rail. Omit threadId for this thread. snooze needs snoozedUntil. Settling or snoozing a thread that is running, this one included, takes effect when its run ends successfully (appliesWhenRunEnds is true); a failed or stopped run, or a message queued behind it, leaves it as it was. Nothing is deleted.",
      promptSnippet: "tau_thread_organize: settle, snooze, unsettle or wake a thread",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("settle"), Type.Literal("unsettle"), Type.Literal("snooze"), Type.Literal("unsnooze")]),
        threadId: Type.Optional(Type.String({ description: "The thread; this thread when left out." })),
        snoozedUntil: Type.Optional(Type.String({ description: "ISO 8601 time the snooze ends, in the future; required for snooze." })),
      }),
      execute: async (_toolCallId: string, params: unknown) => {
        const input = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
        const threadId = typeof input.threadId === "string" && input.threadId.trim() ? input.threadId.trim() : own;
        const action = input.action;
        const now = ports.now();
        if (threadId !== own && !(await ports.threads()).some((thread) => thread.id === threadId)) throw new HostCommandError(`No thread ${threadId} on this host. Find it with tau_find_threads.`);
        if (action === "unsettle" || action === "unsnooze") {
          ports.forgetDeferred(threadId);
          const meta = ports.state().threads[threadId];
          const patch = action === "unsettle" ? unsettlePatch(now) : WAKE_PATCH;
          if (action === "unsettle" ? meta?.settledAt !== undefined : isSnoozed(meta, now)) await ports.apply(threadId, patch);
          return toolResult({ threadId, action, applied: true });
        }
        if (action !== "settle" && action !== "snooze") throw new HostCommandError("action must be settle, unsettle, snooze or unsnooze.");
        let change: DeferredChange = { action: "settle" };
        if (action === "snooze") {
          const until = typeof input.snoozedUntil === "string" ? Date.parse(input.snoozedUntil) : Number.NaN;
          if (!Number.isFinite(until) || until <= now) throw new HostCommandError("snooze needs snoozedUntil, an ISO 8601 time in the future.");
          change = { action: "snooze", until };
        }
        if (ports.isRunning(threadId)) {
          ports.defer(threadId, change);
          return toolResult({ threadId, action, applied: false, appliesWhenRunEnds: true });
        }
        await ports.apply(threadId, change.action === "settle" ? settlePatch(now, "agent") : snoozePatch(change.until));
        return toolResult({ threadId, action, applied: true });
      },
    },
  ];
}
