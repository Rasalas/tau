import { MCP_APP_LIMITS, MCP_APP_PROTOCOL_VERSION } from "./mcp-app-protocol.js";

/**
 * The host side of the MCP Apps bridge (JSON-RPC 2.0, spec 2026-01-26), with
 * no transport: the caller feeds it what the frame posted and hands it a way
 * to post back. ADR 0032 has the decisions behind it.
 */

export type DisplayMode = "inline" | "fullscreen" | "pip";
export type HostContext = Record<string, unknown> & { displayMode?: DisplayMode; availableDisplayModes?: DisplayMode[] };

/** A refusal whose text is meant for the user; it reaches the app as the error message. */
export class BridgeRefusal extends Error {}

export interface BridgeToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}

/** One file of `ui/download-file`, with its name made safe. A link has no data yet. */
export interface BridgeDownloadFile {
  name: string;
  mimeType?: string;
  uri: string;
  link: boolean;
  text?: string;
  /** Base64. */
  blob?: string;
}

export interface McpAppBridgeOptions {
  post(message: unknown): void;
  /** Live values; asked on `ui/initialize` and by `updateHostContext`. */
  hostContext(): HostContext;
  version?: string;
  sandbox?: { csp?: unknown; permissions?: unknown };
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  readResource(uri: string): Promise<unknown>;
  openLink(url: string): Promise<void> | void;
  sendMessage(text: string): Promise<void> | void;
  updateModelContext(context: { content?: unknown[]; structuredContent?: Record<string, unknown> }): Promise<void> | void;
  downloadFile(files: BridgeDownloadFile[]): Promise<void> | void;
  /** Answers the mode that is in effect afterwards. */
  requestDisplayMode(mode: DisplayMode): Promise<DisplayMode> | DisplayMode;
  onSizeChanged?(size: { width?: number; height?: number }): void;
  onRequestTeardown?(): void;
  /** Injected in tests. */
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
  teardownTimeoutMs?: number;
}

export interface McpAppBridge {
  receive(data: unknown): void;
  setToolCall(call: { arguments?: unknown; result?: unknown }): void;
  updateHostContext(): void;
  teardown(): Promise<void>;
  dispose(): void;
}

export const BRIDGE_ERRORS = { invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, failed: -32000 } as const;

const TEARDOWN_TIMEOUT_MS = 2000;
const DISPLAY_MODES: readonly DisplayMode[] = ["inline", "fullscreen", "pip"];
const MAX_DOWNLOAD_FILES = 16;

class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string | number => typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
const invalid = (message: string) => new RpcError(BRIDGE_ERRORS.invalidParams, message);

/** `content` is always an array; null fields are dropped. */
export function normalizeToolResult(value: unknown): BridgeToolResult {
  const source = isObject(value) ? value : {};
  const result: BridgeToolResult = { content: Array.isArray(source.content) ? source.content : [] };
  if (source.structuredContent !== null && source.structuredContent !== undefined) result.structuredContent = source.structuredContent;
  if (typeof source.isError === "boolean") result.isError = source.isError;
  const meta = source["_meta"];
  if (meta !== null && meta !== undefined) result["_meta"] = meta;
  return result;
}

function messageBytes(data: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(data)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** The last path segment, without separators, control characters or a leading dot. */
export function safeFileName(raw: string): string {
  let segment = raw.split(/[\\/]/u).filter(Boolean).pop() ?? "";
  try { segment = decodeURIComponent(segment); } catch { /* keep it as given */ }
  // eslint-disable-next-line no-control-regex
  const name = segment.replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/gu, "_").replace(/^[.\s]+/u, "").trim().slice(0, 120);
  return name || "download";
}

function textOf(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  if (blocks.length === 0) throw invalid("A message needs text.");
  const parts: string[] = [];
  for (const block of blocks) {
    if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") throw invalid("Only text can be sent.");
    parts.push(block.text);
  }
  const text = parts.join("\n");
  if (!text.trim()) throw invalid("A message needs text.");
  return text;
}

function downloadFiles(params: Record<string, unknown>): BridgeDownloadFile[] {
  const { contents } = params;
  if (!Array.isArray(contents) || contents.length === 0 || contents.length > MAX_DOWNLOAD_FILES) throw invalid("contents must list 1 to 16 files.");
  return contents.map((entry): BridgeDownloadFile => {
    if (!isObject(entry)) throw invalid("A file must be an object.");
    if (entry.type === "resource_link") {
      if (typeof entry.uri !== "string" || !entry.uri) throw invalid("A link needs a uri.");
      return { name: safeFileName(typeof entry.name === "string" && entry.name ? entry.name : entry.uri), uri: entry.uri, link: true, ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}) };
    }
    const resource = entry.type === "resource" ? entry.resource : undefined;
    if (!isObject(resource) || typeof resource.uri !== "string") throw invalid("An embedded file needs a resource with a uri.");
    const text = typeof resource.text === "string" ? resource.text : undefined;
    const blob = typeof resource.blob === "string" ? resource.blob : undefined;
    if (text === undefined && blob === undefined) throw invalid("An embedded file needs text or a blob.");
    const bytes = text !== undefined ? new TextEncoder().encode(text).length : Math.floor((blob!.length * 3) / 4);
    if (bytes > MCP_APP_LIMITS.downloadBytes) throw new BridgeRefusal("A file is larger than 25 MiB.");
    return {
      name: safeFileName(resource.uri), uri: resource.uri, link: false,
      ...(typeof resource.mimeType === "string" ? { mimeType: resource.mimeType } : {}),
      ...(text !== undefined ? { text } : { blob: blob! }),
    };
  });
}

export function makeMcpAppBridge(options: McpAppBridgeOptions): McpAppBridge {
  const timers = options.timers ?? { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  let disposed = false;
  let initializeSeen = false;
  let initialized = false;
  let appModes: DisplayMode[] = [];
  let sentContext: HostContext | undefined;
  let call: { arguments?: unknown; result?: unknown } | undefined;
  let sentInput = false;
  let sentResult = false;
  let pending = 0;
  let nextId = 1;
  let closing: { id: number; finish(): void } | undefined;

  const post = (message: unknown) => { if (!disposed) options.post(message); };
  const notify = (method: string, params: unknown) => post({ jsonrpc: "2.0", method, params });
  const respond = (id: string | number, result: unknown) => post({ jsonrpc: "2.0", id, result });
  const fail = (id: string | number, code: number, message: string) => post({ jsonrpc: "2.0", id, error: { code, message } });

  const flushCall = () => {
    if (!initialized || !call) return;
    if (!sentInput) { sentInput = true; notify("ui/notifications/tool-input", { arguments: isObject(call.arguments) ? call.arguments : {} }); }
    if (!sentResult && call.result !== undefined) { sentResult = true; notify("ui/notifications/tool-result", normalizeToolResult(call.result)); }
  };

  const diffContext = (): HostContext | undefined => {
    const next = options.hostContext();
    const changed: HostContext = {};
    let any = false;
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined || JSON.stringify(value) === JSON.stringify(sentContext?.[key])) continue;
      changed[key] = value;
      any = true;
    }
    sentContext = { ...next };
    return any ? changed : undefined;
  };

  const displayMode = async (params: Record<string, unknown>) => {
    const mode = params.mode;
    if (typeof mode !== "string" || !DISPLAY_MODES.includes(mode as DisplayMode)) throw invalid("Unknown display mode.");
    const context = options.hostContext();
    const current = context.displayMode ?? "inline";
    const offered = context.availableDisplayModes ?? ["inline"];
    if (mode === current || !offered.includes(mode as DisplayMode) || !appModes.includes(mode as DisplayMode)) return { mode: current };
    return { mode: await options.requestDisplayMode(mode as DisplayMode) };
  };

  const handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
    ping: () => ({}),
    "ui/initialize": (params) => {
      if (typeof params.protocolVersion !== "string") throw invalid("protocolVersion is required.");
      const capabilities = params.appCapabilities;
      const modes = isObject(capabilities) && Array.isArray(capabilities.availableDisplayModes) ? capabilities.availableDisplayModes : [];
      appModes = modes.filter((mode): mode is DisplayMode => DISPLAY_MODES.includes(mode as DisplayMode));
      initializeSeen = true;
      const hostContext = options.hostContext();
      sentContext = { ...hostContext };
      return {
        protocolVersion: MCP_APP_PROTOCOL_VERSION,
        hostInfo: { name: "tau", version: options.version ?? "0" },
        hostCapabilities: {
          openLinks: {}, serverTools: {}, serverResources: {}, logging: {},
          message: { text: {} }, updateModelContext: { text: {}, structuredContent: {} }, downloadFile: {},
          sandbox: { ...(options.sandbox?.csp !== undefined ? { csp: options.sandbox.csp } : {}), ...(options.sandbox?.permissions !== undefined ? { permissions: options.sandbox.permissions } : {}) },
        },
        hostContext,
      };
    },
    "tools/call": async (params) => {
      if (typeof params.name !== "string" || !params.name) throw invalid("name is required.");
      if (params.arguments !== undefined && !isObject(params.arguments)) throw invalid("arguments must be an object.");
      return normalizeToolResult(await options.callTool({ name: params.name, arguments: (params.arguments as Record<string, unknown> | undefined) ?? {} }));
    },
    "resources/read": async (params) => {
      if (typeof params.uri !== "string" || !params.uri) throw invalid("uri is required.");
      const result = await options.readResource(params.uri);
      return { contents: isObject(result) && Array.isArray(result.contents) ? result.contents : [] };
    },
    "ui/open-link": async (params) => {
      let url: URL;
      try { url = new URL(String(params.url)); } catch { throw invalid("url must be a link."); }
      if (url.protocol !== "http:" && url.protocol !== "https:") throw invalid("Only http and https links open.");
      await options.openLink(url.href);
      return {};
    },
    "ui/message": async (params) => {
      if (params.role !== "user") throw invalid("role must be user.");
      await options.sendMessage(textOf(params.content));
      return {};
    },
    "ui/update-model-context": async (params) => {
      if (params.content !== undefined && !Array.isArray(params.content)) throw invalid("content must be an array.");
      if (params.structuredContent !== undefined && !isObject(params.structuredContent)) throw invalid("structuredContent must be an object.");
      await options.updateModelContext({
        ...(params.content !== undefined ? { content: params.content } : {}),
        ...(params.structuredContent !== undefined ? { structuredContent: params.structuredContent as Record<string, unknown> } : {}),
      });
      return {};
    },
    "ui/request-display-mode": displayMode,
    "ui/download-file": async (params) => {
      const files = downloadFiles(params);
      try {
        await options.downloadFile(files);
      } catch (error) {
        if (error instanceof BridgeRefusal) return { isError: true };
        throw error;
      }
      return {};
    },
  };

  const notifications: Record<string, (params: Record<string, unknown>) => void> = {
    "ui/notifications/initialized": () => {
      if (!initializeSeen || initialized) return;
      initialized = true;
      const changed = diffContext();
      if (changed) notify("ui/notifications/host-context-changed", changed);
      flushCall();
    },
    "ui/notifications/size-changed": (params) => {
      const size: { width?: number; height?: number } = {};
      for (const key of ["width", "height"] as const) {
        const value = params[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0) size[key] = value;
      }
      if (size.width !== undefined || size.height !== undefined) options.onSizeChanged?.(size);
    },
    "ui/notifications/request-teardown": () => options.onRequestTeardown?.(),
  };

  const request = async (id: string | number, method: string, params: Record<string, unknown>) => {
    const handler = handlers[method];
    if (!handler) return fail(id, BRIDGE_ERRORS.methodNotFound, `Unknown method ${method}.`);
    if (!initializeSeen && method !== "ping" && method !== "ui/initialize") return fail(id, BRIDGE_ERRORS.invalidRequest, "Send ui/initialize first.");
    if (pending >= MCP_APP_LIMITS.pendingRequests) return fail(id, BRIDGE_ERRORS.failed, "Too many requests are waiting.");
    pending += 1;
    try {
      const result = await handler(params);
      respond(id, result);
    } catch (error) {
      if (error instanceof RpcError) fail(id, error.code, error.message);
      else fail(id, BRIDGE_ERRORS.failed, error instanceof Error && error.message ? error.message : "The host could not do that.");
    } finally {
      pending -= 1;
    }
  };

  return {
    receive(data) {
      if (disposed || !isObject(data) || data.jsonrpc !== "2.0") return;
      const hasId = data.id !== undefined;
      if (hasId && !isId(data.id)) return;
      if (typeof data.method !== "string") {
        // A response to the request the host sent: only the teardown.
        if (hasId && closing && data.id === closing.id && ("result" in data || "error" in data)) closing.finish();
        return;
      }
      const params = isObject(data.params) ? data.params : data.params === undefined ? {} : undefined;
      if (messageBytes(data) > MCP_APP_LIMITS.messageBytes) {
        if (hasId) fail(data.id as string | number, BRIDGE_ERRORS.invalidRequest, "Message is larger than 256 KiB.");
        return;
      }
      if (hasId) {
        if (params === undefined) return fail(data.id as string | number, BRIDGE_ERRORS.invalidParams, "params must be an object.");
        void request(data.id as string | number, data.method, params);
        return;
      }
      try { notifications[data.method]?.(params ?? {}); } catch { /* a notification has no one to tell */ }
    },
    setToolCall(next) {
      call = { ...call, ...next };
      flushCall();
    },
    updateHostContext() {
      if (disposed || !initialized) return;
      const changed = diffContext();
      if (changed) notify("ui/notifications/host-context-changed", changed);
    },
    teardown() {
      if (disposed || !initialized || closing) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const id = nextId++;
        const handle = timers.set(() => entry.finish(), options.teardownTimeoutMs ?? TEARDOWN_TIMEOUT_MS);
        const entry = { id, finish: () => { timers.clear(handle); if (closing === entry) closing = undefined; resolve(); } };
        closing = entry;
        post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} });
      });
    },
    dispose() {
      disposed = true;
      closing?.finish();
    },
  };
}
