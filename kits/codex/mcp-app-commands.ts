import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import { join } from "node:path";
import { McpAppContexts } from "./mcp-app-context.js";
import { McpAppStore } from "./mcp-app-store.js";
import { McpAppRequests } from "./mcp-app-requests.js";
import type { McpAppCapture } from "./events.js";
import type { McpAppReader } from "./mcp-apps.js";
import { MCP_APP_COMMANDS, MCP_APP_LIMITS, type McpAppOpen, type McpAppOpenInput, type McpAppTarget } from "./mcp-app-protocol.js";
import { McpApps, type McpAppThread } from "./mcp-apps.js";

/** The seven commands the app card calls; every input is checked here before it reaches a request. */
const MAX_ID = 200;
const MAX_NAMES = 100;
const TOOL_DEFINITION_MS = 2_000;

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new HostCommandError("The request is malformed.");
  return input as Record<string, unknown>;
}

function id(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID) throw new HostCommandError(`The request names no valid ${what}.`);
  return value;
}

function target(input: unknown): McpAppTarget & Record<string, unknown> {
  const value = record(input);
  return { ...value, threadId: id(value.threadId, "thread"), itemId: id(value.itemId, "tool run") };
}

function textOf(value: unknown, what: string, max = MCP_APP_LIMITS.messageBytes): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > max) throw new HostCommandError(`The request carries no valid ${what}.`);
  return value;
}

export interface McpAppCommandDeps {
  apps: McpApps;
  requests: McpAppRequests;
  thread(threadId: string): McpAppThread | undefined;
}

export function registerMcpAppCommands(context: Pick<HostExtensionContext, "registerCommand" | "services">, deps: McpAppCommandDeps): void {
  const { apps, requests } = deps;
  const resources = () => context.services.browserResources;
  const command = context.registerCommand;

  // Minting a frame and releasing it change nothing a device paired Read only could not see.
  command(MCP_APP_COMMANDS.open, async (input): Promise<McpAppOpen> => {
    const call = target(input);
    const scheme = (call as Partial<McpAppOpenInput>).colorScheme === "dark" ? "dark" : "light";
    const browserResources = resources();
    if (!browserResources) throw new HostCommandError("This machine serves no sandboxed frames.");
    const opened = await apps.open(call.threadId, call.itemId);
    if (opened.state !== "ready") return opened;
    const { html, meta } = opened.app;
    const path = browserResources.publishFrame({ html, ...(meta.csp ? { csp: meta.csp } : {}), colorScheme: scheme });
    const live = deps.thread(call.threadId)?.live();
    // Best effort: the card works without the definition, so a slow or failing server never holds the open.
    const toolDefinition = live?.session.listMcpTools
      ? await Promise.race([
        live.session.listMcpTools(live.codexThreadId, meta.server).then((tools) => Object.hasOwn(tools, meta.tool) ? tools[meta.tool] : undefined, () => undefined),
        new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), TOOL_DEFINITION_MS).unref?.(); }),
      ])
      : undefined;
    return {
      state: "ready",
      path,
      server: meta.server,
      tool: meta.tool,
      resourceUri: meta.resourceUri,
      ...(meta.prefersBorder !== undefined ? { prefersBorder: meta.prefersBorder } : {}),
      ...(meta.permissions ? { permissions: meta.permissions } : {}),
      ...(meta.csp ? { csp: meta.csp } : {}),
      ...(toolDefinition !== undefined ? { toolDefinition } : {}),
      toolInput: meta.toolInput,
      ...(meta.toolResult ? { toolResult: meta.toolResult } : {}),
      live: Boolean(live),
    };
  }, { access: "read" });

  command(MCP_APP_COMMANDS.release, (input) => {
    const value = record(input);
    if (typeof value.path === "string") resources()?.release(value.path);
    return {};
  }, { access: "read" });

  command(MCP_APP_COMMANDS.callTool, (input) => {
    const call = target(input);
    const args = call.arguments === undefined ? {} : record(call.arguments);
    if (Buffer.byteLength(JSON.stringify(args), "utf8") > MCP_APP_LIMITS.messageBytes) throw new HostCommandError("The tool arguments are too large.");
    return requests.callTool({ threadId: call.threadId, itemId: call.itemId, name: id(call.name, "tool name"), arguments: args });
  });

  command(MCP_APP_COMMANDS.readResource, (input) => {
    const call = target(input);
    return requests.readResource({ threadId: call.threadId, itemId: call.itemId, uri: textOf(call.uri, "resource uri", 4096) });
  });

  command(MCP_APP_COMMANDS.sendMessage, (input) => {
    const call = target(input);
    return requests.sendMessage({ threadId: call.threadId, itemId: call.itemId, text: textOf(call.text, "message") });
  });

  command(MCP_APP_COMMANDS.approve, (input) => {
    const call = target(input);
    if (call.kind !== "download") throw new HostCommandError("Tau asks only about downloads here.");
    if (!Array.isArray(call.names) || call.names.length === 0 || call.names.length > MAX_NAMES) throw new HostCommandError("The request names no files.");
    const names = call.names.map((name) => textOf(name, "file name", 512).replace(/[\r\n]+/gu, " "));
    return requests.approve({ threadId: call.threadId, itemId: call.itemId, kind: "download", names });
  });

  command(MCP_APP_COMMANDS.modelContext, (input) => {
    const call = target(input);
    const content = call.content === undefined ? undefined : Array.isArray(call.content) ? call.content : (() => { throw new HostCommandError("The context content must be a list."); })();
    const structured = call.structuredContent === undefined ? undefined : record(call.structuredContent);
    return requests.modelContext({ threadId: call.threadId, itemId: call.itemId, ...(content ? { content } : {}), ...(structured ? { structuredContent: structured } : {}) });
  });
}

/**
 * The kit's MCP App machinery: store, commands, and the thread's lifecycle.
 * `forThread` gives a thread's backend the two hooks it needs.
 */
export function startMcpApps(context: Pick<HostExtensionContext, "registerCommand" | "services">, thread: (threadId: string) => McpAppThread | undefined): {
  forThread(threadId: string): { onMcpApp(capture: McpAppCapture, reader: McpAppReader): void; appContext: () => ReturnType<McpAppContexts["take"]> };
} {
  const { services } = context;
  const store = new McpAppStore({ directory: join(services.stateDir, "mcp-apps") });
  const contexts = new McpAppContexts(store);
  const apps = new McpApps(store, { log: (message) => services.log("codex.mcp-app.capture-failed", message) });
  const requests = new McpAppRequests({
    store,
    contexts,
    thread,
    send: async (threadId, text) => {
      if (!services.sessions.send) throw new HostCommandError("This machine cannot send a message for an app.");
      await services.sessions.send(threadId, text, { delivery: "prompt" });
    },
  });
  registerMcpAppCommands(context, { apps, requests, thread });
  services.registerThreadLifecycle({
    threadDeleted: async (threadId) => {
      apps.forgetThread(threadId);
      contexts.forget(threadId);
      await store.forgetThread(threadId);
    },
  });
  return {
    forThread: (threadId) => ({
      onMcpApp: (capture, reader) => apps.capture(threadId, capture, reader),
      appContext: () => contexts.take(threadId),
    }),
  };
}
