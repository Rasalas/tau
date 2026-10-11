import { HostCommandError } from "tau/host-extension";
import type { CodexMcpTool } from "./app-server.js";
import { ALLOW, DENY } from "./approvals.js";
import type { McpAppContexts } from "./mcp-app-context.js";
import { MCP_APP_LIMITS, type McpAppApproveInput, type McpAppCallToolInput, type McpAppCallToolResult, type McpAppModelContextInput, type McpAppReadResourceInput, type McpAppSendMessageInput, type McpAppTarget } from "./mcp-app-protocol.js";
import type { McpAppMeta, McpAppStore } from "./mcp-app-store.js";
import type { McpAppSession, McpAppThread } from "./mcp-apps.js";

/**
 * What an app asks of its MCP server and of the user. The server and the tool
 * come from the stored run, never from a request, so an app reaches only its
 * own server. Nothing here starts a session or a turn for an app.
 */
export const NOT_RUNNING = "This thread's Codex session is not running. Send a message in the thread to start it again.";
const GONE = "This app is no longer available.";
const PROMPT_MESSAGE_BYTES = 8 * 1024;

export interface McpAppRequestDeps {
  store: McpAppStore;
  contexts: McpAppContexts;
  /** The thread's backend, when the host holds it. */
  thread(threadId: string): McpAppThread | undefined;
  /** Sends the user's message, as the composer would. */
  send(threadId: string, text: string): Promise<void>;
}

/** Text shown in a prompt card, shortened with a note once past the limit. */
export function clipForPrompt(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= PROMPT_MESSAGE_BYTES) return text;
  const shown = Buffer.from(text, "utf8").subarray(0, PROMPT_MESSAGE_BYTES).toString("utf8").replace(/�$/u, "");
  return `${shown}\n… (${text.length - shown.length} more characters not shown)`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An app may call a tool unless its `_meta.ui.visibility` leaves `app` out. */
export function callableByApp(tool: CodexMcpTool): boolean {
  const ui = isRecord(tool["_meta"]) && isRecord(tool["_meta"].ui) ? tool["_meta"].ui : undefined;
  const visibility = ui?.visibility;
  return visibility === undefined || (Array.isArray(visibility) && visibility.includes("app"));
}

export class McpAppRequests {
  constructor(private readonly deps: McpAppRequestDeps) {}

  private async run(target: McpAppTarget): Promise<McpAppMeta> {
    const meta = await this.deps.store.meta(target.threadId, target.itemId);
    if (!meta) throw new HostCommandError(GONE);
    return meta;
  }

  private live(threadId: string): { thread: McpAppThread; live: McpAppSession } {
    const thread = this.deps.thread(threadId);
    const live = thread?.live();
    if (!thread || !live) throw new HostCommandError(NOT_RUNNING);
    return { thread, live };
  }

  /** The user's answer on the thread's prompt cards; anything but Allow is no. */
  private async allowed(thread: McpAppThread, title: string, message: string): Promise<boolean> {
    if (!thread.ask) throw new HostCommandError("This thread cannot ask for approval here, so the request was not run.");
    const answer = await thread.ask({ kind: "select", title, message: clipForPrompt(message), options: [ALLOW, DENY] });
    return ("value" in answer && !answer.typed && answer.value === ALLOW) || ("confirmed" in answer && answer.confirmed === true);
  }

  /** The tool's definition on the run's server; the server is asked, not the app. */
  async toolDefinition(target: McpAppTarget, name: string): Promise<CodexMcpTool | undefined> {
    const meta = await this.run(target);
    const { live } = this.live(target.threadId);
    if (!live.session.listMcpTools) throw new HostCommandError("This Codex version cannot list MCP tools; update Codex in Settings → Runtimes.");
    const tools = await live.session.listMcpTools(live.codexThreadId, meta.server);
    return Object.hasOwn(tools, name) ? tools[name] : undefined;
  }

  async callTool(input: McpAppCallToolInput): Promise<McpAppCallToolResult> {
    const meta = await this.run(input);
    const { thread } = this.live(input.threadId);
    const tool = await this.toolDefinition(input, input.name).catch((error: unknown) => {
      if (error instanceof HostCommandError) throw error;
      throw new HostCommandError(`Could not read the tools of ${meta.server}.`);
    });
    if (!tool || !callableByApp(tool)) throw new HostCommandError("This app cannot call that tool.");
    const readOnly = isRecord(tool.annotations) && tool.annotations.readOnlyHint === true;
    if (!readOnly && !await this.allowed(thread, `Allow ${meta.server} to run ${input.name}?`, JSON.stringify(input.arguments, null, 2))) {
      throw new HostCommandError("Declined by the user.");
    }
    // The session may have gone while the question was open.
    const { live } = this.live(input.threadId);
    if (!live.session.callMcpTool) throw new HostCommandError("This Codex version cannot call MCP tools for an app; update Codex in Settings → Runtimes.");
    const result = await live.session.callMcpTool({ threadId: live.codexThreadId, server: meta.server, tool: input.name, arguments: input.arguments });
    return { content: Array.isArray(result.content) ? result.content : [], ...(result.structuredContent != null ? { structuredContent: result.structuredContent } : {}), ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}), ...(result["_meta"] != null ? { "_meta": result["_meta"] } : {}) };
  }

  async readResource(input: McpAppReadResourceInput): Promise<{ contents: unknown[] }> {
    const meta = await this.run(input);
    const { live } = this.live(input.threadId);
    if (!live.session.readMcpResource) throw new HostCommandError("This Codex version cannot read MCP resources for an app; update Codex in Settings → Runtimes.");
    const read = await live.session.readMcpResource({ threadId: live.codexThreadId, server: meta.server, uri: input.uri });
    return { contents: Array.isArray(read.contents) ? read.contents : [] };
  }

  async sendMessage(input: McpAppSendMessageInput): Promise<Record<string, never>> {
    const meta = await this.run(input);
    const { thread } = this.live(input.threadId);
    if (!await this.allowed(thread, `Send this message from ${meta.server}?`, input.text)) throw new HostCommandError("Declined by the user.");
    this.live(input.threadId);
    await this.deps.send(input.threadId, input.text);
    return {};
  }

  /** Whether the user lets the app save these files. */
  async approve(input: McpAppApproveInput): Promise<boolean> {
    const meta = await this.run(input);
    const thread = this.deps.thread(input.threadId);
    if (!thread) throw new HostCommandError(NOT_RUNNING);
    const shown = input.names.slice(0, 3).join(", ") + (input.names.length > 3 ? ` and ${input.names.length - 3} more` : "");
    return this.allowed(thread, `Save ${shown} from ${meta.server}?`, input.names.join("\n"));
  }

  /** Replaces what the app told the model; the next turn carries it. */
  async modelContext(input: McpAppModelContextInput): Promise<Record<string, never>> {
    const meta = await this.run(input);
    const parts: string[] = [];
    for (const block of input.content ?? []) {
      if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") throw new HostCommandError("Only text content can go to the model.");
      parts.push(block.text);
    }
    if (input.structuredContent !== undefined) parts.push(JSON.stringify(input.structuredContent));
    const text = parts.join("\n");
    if (Buffer.byteLength(text, "utf8") > MCP_APP_LIMITS.modelContextBytes) throw new HostCommandError("The app's context is too large.");
    await this.deps.contexts.set(input.threadId, input.itemId, { server: meta.server, tool: meta.tool, text });
    return {};
  }
}
