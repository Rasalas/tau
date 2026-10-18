import type { ThreadIndexSnapshot } from "../shared/contracts.js";
import type { TranscriptPage } from "../shared/host-protocol.js";
import { asHostTranscriptCursor, type HostTranscriptCursor } from "../shared/transcript-cursor.js";
import type { ExternalMcpAuthorization } from "./external-mcp-authorization.js";
import { McpOAuthError } from "./external-mcp-policy.js";

/** Read-only host seam. External clients never receive a generic command dispatcher. */
export interface ExternalMcpReadHost {
  threadIndexSnapshot(): ThreadIndexSnapshot;
  loadTranscript(threadId: string, cursor?: HostTranscriptCursor): Promise<TranscriptPage>;
}

const projectId = { type: "string", minLength: 1, maxLength: 128 };
export const EXTERNAL_MCP_READ_TOOLS = [
  { name: "tau_list_projects", description: "List the projects this client may read.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "tau_list_threads", description: "List up to 100 local threads in an approved project. Use offset to continue.", inputSchema: { type: "object", properties: { projectId, offset: { type: "integer", minimum: 0, maximum: 1_000_000 } }, required: ["projectId"], additionalProperties: false } },
  { name: "tau_read_thread", description: "Read a bounded page of conversation text in an approved project. Long text is truncated explicitly; tool output and attachments are excluded.", inputSchema: { type: "object", properties: { projectId, threadId: projectId, cursor: { type: "string", minLength: 1, maxLength: 4096 } }, required: ["projectId", "threadId"], additionalProperties: false } },
].map((tool) => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));

function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }

async function cancelRead<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new McpOAuthError("access_denied"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([read, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Each call obtains fresh authority; neither tool names nor target IDs confer it. */
export async function callExternalMcpReadTool(
  auth: ExternalMcpAuthorization, token: string, host: ExternalMcpReadHost,
  name: string, input: unknown, signal: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new McpOAuthError("invalid_request");
  const args = input as Record<string, unknown>;
  const permitted = name === "tau_list_projects" ? [] : name === "tau_list_threads" ? ["projectId", "offset"] : name === "tau_read_thread" ? ["projectId", "threadId", "cursor"] : undefined;
  if (!permitted || Object.keys(args).some((key) => !permitted.includes(key))) throw new McpOAuthError("invalid_request");
  if (name !== "tau_list_projects" && !text(args.projectId, 128)) throw new McpOAuthError("invalid_request");
  if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || (args.offset as number) < 0 || (args.offset as number) > 1_000_000)) throw new McpOAuthError("invalid_request");
  if (name === "tau_read_thread" && (!text(args.threadId, 128) || (args.cursor !== undefined && !text(args.cursor, 4096)))) throw new McpOAuthError("invalid_request");
  const grant = auth.authenticate(token, auth.resource);
  if (!grant) throw new McpOAuthError("invalid_grant");
  const selectedProject = name === "tau_list_projects" ? grant.projectIds[0]! : args.projectId as string;
  const lease = auth.lease(token, auth.resource, { scope: "tau:read", projectId: selectedProject });
  try {
    signal.throwIfAborted();
    lease.signal.throwIfAborted();
    const index = host.threadIndexSnapshot();
    let result: unknown;
    if (name === "tau_list_projects") {
      result = { projects: index.projects.filter((project) => project.workspaceId && grant.projectIds.includes(project.workspaceId)).map((project) => ({ id: project.workspaceId!, name: project.name.slice(0, 200) })) };
    } else {
      if (!index.projects.some((project) => project.workspaceId === selectedProject)) throw new McpOAuthError("access_denied");
      const threads = index.sessions.filter((thread) => !thread.machine && thread.workspaceId === selectedProject);
      if (name === "tau_list_threads") {
        const offset = args.offset as number | undefined ?? 0;
        const ordered = [...threads].sort((a, b) => b.modifiedAt - a.modifiedAt);
        result = { threads: ordered.slice(offset, offset + 100).map((thread) => ({ id: thread.id, title: thread.title.slice(0, 300), modifiedAt: thread.modifiedAt, runtime: thread.backendKind ?? "pi" })), ...(offset + 100 < threads.length ? { nextOffset: offset + 100 } : {}) };
      } else {
        const thread = threads.find((entry) => entry.id === args.threadId);
        if (!thread) throw new McpOAuthError("access_denied");
        const page = await cancelRead(host.loadTranscript(thread.id, args.cursor ? asHostTranscriptCursor(args.cursor as string) : undefined), AbortSignal.any([signal, lease.signal]));
        if (page.sessionId !== thread.id) throw new McpOAuthError("access_denied");
        const conversation = page.messages.filter((message) => message.kind !== "shell" && !message.excludedFromContext && (message.role === "user" || message.role === "assistant"));
        result = { threadId: thread.id, messages: conversation.slice(-32).map((message) => ({ role: message.role, text: message.text.slice(0, 4096), timestamp: message.timestamp })), truncated: conversation.length > 32 || conversation.some((message) => message.text.length > 4096), hasMore: page.hasMore, ...(page.olderCursor && page.olderCursor.length <= 4096 ? { olderCursor: page.olderCursor } : {}) };
      }
    }
    signal.throwIfAborted();
    lease.signal.throwIfAborted();
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output) > 1024 * 1024) throw new McpOAuthError("temporarily_unavailable");
    return { content: [{ type: "text", text: output }] };
  } finally { lease.release(); }
}
