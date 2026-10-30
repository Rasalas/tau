import type { ExtensionUiPrompt } from "../shared/contracts.js";
import type { ExternalMcpAuthorization, ExternalMcpGrant } from "./external-mcp-authorization.js";
import type { HostStartedThread, HostThread, HostThreadStartOptions } from "./host-extension-contracts.js";
import { McpOAuthError } from "./external-mcp-policy.js";
import type { ExternalMcpReadHost } from "./external-mcp-read-tools.js";
import { ExternalMcpRefusal, type ExternalMcpThreads } from "./external-mcp-threads.js";

/**
 * The control seam (ADR 0046): start, steer and stop threads, nothing else.
 * Still no generic command dispatcher and no runtime session of its own.
 */
export interface ExternalMcpControlHost extends ExternalMcpReadHost {
  resolveWorkspacePath(workspaceId: string): string;
  startThread(options: HostThreadStartOptions): Promise<HostStartedThread>;
  sendToThread(sessionId: string, text: string, delivery: "prompt" | "steer" | "queue"): Promise<void>;
  abort(sessionId: string): Promise<void>;
  liveThread(sessionId: string): Pick<HostThread, "backendKind" | "isIdle" | "isStreaming" | "entries"> | undefined;
  replayOpenUiPrompts(): ExtensionUiPrompt[];
}

const MAX_TEXT = 32_000;
/**
 * The runtimes known to hold each ceiling (ADR 0046), by kind before any
 * `@instance`. Pi, Claude Code, Codex, OpenCode, Grok and Cursor apply every
 * level per turn; Antigravity has no read-only mode and asks instead. A generic
 * ACP agent without matching session modes runs as it likes, and a thread on
 * another machine runs under that machine's level: only `full` reaches them.
 */
const HOLDS: Record<string, readonly ExternalMcpGrant["execution"][]> = {
  pi: ["read-only", "ask", "auto", "full"],
  "claude-code": ["read-only", "ask", "auto", "full"],
  codex: ["read-only", "ask", "auto", "full"],
  opencode: ["read-only", "ask", "auto", "full"],
  grok: ["read-only", "ask", "auto", "full"],
  cursor: ["read-only", "ask", "auto", "full"],
  antigravity: ["ask", "auto", "full"],
};

/** Whether a runtime kind enforces a ceiling; exported for tests. */
export function runtimeHoldsCeiling(kind: string, ceiling: ExternalMcpGrant["execution"]): boolean {
  return ceiling === "full" ? kind.split("@")[0] !== "machine" : HOLDS[kind.split("@")[0]!]?.includes(ceiling) === true;
}

const id = { type: "string", minLength: 1, maxLength: 128 };
const text = { type: "string", minLength: 1, maxLength: MAX_TEXT };
export const EXTERNAL_MCP_CONTROL_TOOLS = [
  {
    name: "tau_start_thread",
    description: "Start a new thread in an approved project with a first message. It runs under this client's execution ceiling; edits and commands the ceiling does not allow are refused or wait for the machine's owner to confirm in Tau. Returns the new thread's id.",
    inputSchema: { type: "object", properties: { projectId: id, prompt: text, title: { type: "string", minLength: 1, maxLength: 200 }, runtime: { type: "string", minLength: 1, maxLength: 64, description: "A runtime this machine offers, e.g. pi, claude-code or codex; Pi when absent." }, model: { type: "object", properties: { provider: id, id }, required: ["provider", "id"], additionalProperties: false } }, required: ["projectId", "prompt"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "tau_send_message",
    description: "Send a message to a thread this client started. An idle thread starts a turn; a running one gets it now as a steer, or after its turn with delivery \"queue\".",
    inputSchema: { type: "object", properties: { projectId: id, threadId: id, text, delivery: { type: "string", enum: ["steer", "queue"] } }, required: ["projectId", "threadId", "text"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "tau_stop_thread",
    description: "Stop the running turn of a thread this client started, as Tau's stop button does. Messages it had queued wait for the machine's owner.",
    inputSchema: { type: "object", properties: { projectId: id, threadId: id }, required: ["projectId", "threadId"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "tau_thread_status",
    description: "Whether a thread in an approved project is idle, running or waiting for the machine's owner to answer, with its last activity. Says whether this client may control it.",
    inputSchema: { type: "object", properties: { projectId: id, threadId: id }, required: ["projectId", "threadId"], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const;

export type ExternalMcpControlToolName = typeof EXTERNAL_MCP_CONTROL_TOOLS[number]["name"];
const KEYS: Record<ExternalMcpControlToolName, readonly string[]> = {
  tau_start_thread: ["projectId", "prompt", "title", "runtime", "model"],
  tau_send_message: ["projectId", "threadId", "text", "delivery"],
  tau_stop_thread: ["projectId", "threadId"],
  tau_thread_status: ["projectId", "threadId"],
};

export function isExternalMcpControlTool(name: string): name is ExternalMcpControlToolName {
  return Object.hasOwn(KEYS, name);
}

function string(value: unknown, max: number, optional = false): string | undefined {
  if (optional && value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\t\r]/gu, ""))) throw new McpOAuthError("invalid_request");
  return value;
}

function refuseRuntime(kind: string, ceiling: ExternalMcpGrant["execution"]): void {
  if (!runtimeHoldsCeiling(kind, ceiling)) throw new ExternalMcpRefusal(`The ${kind} runtime cannot hold a "${ceiling}" ceiling, so this client may not drive it.`);
}

/**
 * One control call. Fresh grant authority and project scope every time; the
 * thread must belong to the project named, and only a thread this grant
 * started may be steered or stopped. Status reads any thread of the project.
 */
export async function callExternalMcpControlTool(
  auth: ExternalMcpAuthorization, token: string, host: ExternalMcpControlHost, threads: ExternalMcpThreads,
  name: string, input: unknown, signal: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (!isExternalMcpControlTool(name) || !input || typeof input !== "object" || Array.isArray(input)) throw new McpOAuthError("invalid_request");
  const args = input as Record<string, unknown>;
  if (Object.keys(args).some((key) => !KEYS[name].includes(key))) throw new McpOAuthError("invalid_request");
  const projectId = string(args.projectId, 128)!;
  const threadId = name === "tau_start_thread" ? undefined : string(args.threadId, 128)!;
  const lease = auth.lease(token, auth.resource, { scope: "tau:threads", projectId });
  const cancelled = AbortSignal.any([signal, lease.signal]);
  try {
    cancelled.throwIfAborted();
    const index = host.threadIndexSnapshot();
    const project = index.projects.find((entry) => entry.workspaceId === projectId && !entry.projectless);
    if (!project) throw new McpOAuthError("access_denied");
    const grant = lease.grant;
    let result: unknown;
    if (name === "tau_start_thread") {
      const prompt = string(args.prompt, MAX_TEXT)!;
      const title = string(args.title, 200, true);
      const runtime = string(args.runtime, 64, true);
      const model = args.model === undefined ? undefined : args.model && typeof args.model === "object" && !Array.isArray(args.model) && Object.keys(args.model).every((key) => key === "provider" || key === "id")
        ? { provider: string((args.model as Record<string, unknown>).provider, 128)!, id: string((args.model as Record<string, unknown>).id, 128)! } : (() => { throw new McpOAuthError("invalid_request"); })();
      refuseRuntime(runtime ?? "pi", grant.execution);
      const started = await host.startThread({
        cwd: host.resolveWorkspacePath(projectId), prompt,
        ...(title ? { title } : {}), ...(runtime ? { backend: runtime } : {}), ...(model ? { model } : {}),
        beforePrompt: async (thread) => {
          cancelled.throwIfAborted();
          refuseRuntime(thread.backendKind, grant.execution);
          const client = auth.clientName(grant.id);
          await threads.claim(thread, { grantId: grant.id, projectId, execution: grant.execution, startedAt: Date.now(), ...(client ? { client } : {}) });
          // Revoked while the claim was written: the start fails and the host discards the thread.
          cancelled.throwIfAborted();
        },
      });
      // Revoked after the prompt was admitted: its grant's authority is gone, so is the turn.
      if (lease.signal.aborted) await host.abort(started.sessionId).catch(() => undefined);
      lease.signal.throwIfAborted();
      result = { threadId: started.sessionId, projectId, ceiling: grant.execution, ...(started.title ? { title: started.title.slice(0, 300) } : {}) };
    } else {
      const thread = index.sessions.find((entry) => entry.id === threadId && !entry.machine && entry.workspaceId === projectId);
      if (!thread) throw new McpOAuthError("access_denied");
      const owned = threads.owner(thread.id)?.grantId === grant.id;
      const live = host.liveThread(thread.id);
      if (name === "tau_thread_status") {
        const question = host.replayOpenUiPrompts().find((prompt) => prompt.sessionId === thread.id);
        const state = question ? "waiting-for-answer" : live?.isStreaming() || (live && !live.isIdle()) ? "running" : "idle";
        result = {
          threadId: thread.id, state, lastActivityAt: thread.modifiedAt, runtime: live?.backendKind ?? thread.backendKind ?? "pi",
          controllable: owned, ...(owned ? { ceiling: threads.ceiling(thread.id) } : {}),
          ...(question ? { question: { kind: question.kind, title: question.title.slice(0, 200) } } : {}),
          ...(thread.queued?.length ? { queued: thread.queued.length } : {}), ...(thread.queueHeld ? { queueHeld: true } : {}),
          ...(thread.turnError ? { lastTurnFailed: true } : {}), ...(thread.interrupted ? { interrupted: true } : {}),
        };
      } else {
        if (!owned) throw new ExternalMcpRefusal("This client may only control threads it started. Other threads stay read-only for it.");
        if (name === "tau_stop_thread") {
          const running = Boolean(live && !live.isIdle());
          if (running) await host.abort(thread.id);
          result = { threadId: thread.id, stopped: running };
        } else {
          const message = string(args.text, MAX_TEXT)!;
          if (args.delivery !== undefined && args.delivery !== "steer" && args.delivery !== "queue") throw new McpOAuthError("invalid_request");
          refuseRuntime(live?.backendKind ?? thread.backendKind ?? "pi", grant.execution);
          const ceiling = threads.ceiling(thread.id) ?? grant.execution;
          await threads.apply(thread.id, ceiling);
          cancelled.throwIfAborted();
          const delivery = live?.isStreaming() ? (args.delivery as "steer" | "queue" | undefined) ?? "steer" : "prompt";
          await host.sendToThread(thread.id, message, delivery);
          result = { threadId: thread.id, delivery: delivery === "prompt" ? "started" : delivery === "steer" ? "steered" : "queued", ceiling };
        }
      }
    }
    lease.signal.throwIfAborted();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } finally { lease.release(); }
}
