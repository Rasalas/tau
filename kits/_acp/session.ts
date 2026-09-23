import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { ACP_INTERNAL_ERROR, ACP_INVALID_PARAMS, ACP_RESOURCE_NOT_FOUND, AcpClient, AcpRequestError, type AcpExitedError, type AcpProcess, type AcpRequestHandler } from "./client.js";
import type { AcpPromptResponse, AcpSessionUpdate } from "./events.js";

/**
 * One ACP conversation with an agent process: the handshake, one session
 * (new, resumed or loaded), prompts, cancellation, and what the agent asks of
 * the client in between: permissions, forms and, when the client offers
 * them, reads and writes inside the workspace. A kit adds the sign-in and
 * extension methods its agent speaks.
 */
export interface AcpPermissionOption { optionId: string; name: string; kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"; _meta?: Record<string, unknown> | null }
export interface AcpPermissionRequest {
  sessionId: string;
  options: AcpPermissionOption[];
  toolCall: { toolCallId: string; title?: string | null; kind?: string | null; rawInput?: unknown; locations?: Array<{ path: string }> | null; content?: unknown };
}
export type AcpPermissionResponse = { outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } };
/** `session/elicitation`, or the SDK's `elicitation/create`: a form (or a URL, which Tau does not offer) the agent wants filled. */
export interface AcpElicitationRequest { sessionId?: string; mode?: string; message?: string; requestedSchema?: unknown; url?: string }
export type AcpElicitationAnswer = { action: "accept"; content: Record<string, string | number | boolean | string[]> } | { action: "decline" } | { action: "cancel" };

export interface AcpSelectOption { value: string; name: string; description?: string | null }
export interface AcpConfigOption {
  type: "select" | "boolean";
  id: string;
  name: string;
  category?: string | null;
  currentValue: string | boolean;
  options?: Array<AcpSelectOption | { group: string; name: string; options: AcpSelectOption[] }>;
}
export interface AcpSessionSetup {
  sessionId: string;
  configOptions?: AcpConfigOption[] | null;
  models?: { availableModels: Array<{ modelId: string; name: string; description?: string | null; _meta?: Record<string, unknown> | null }>; currentModelId: string } | null;
  modes?: { availableModes: Array<{ id: string; name: string; description?: string | null }>; currentModeId: string } | null;
}
export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: { name: string; version: string; title?: string | null } | null;
  authMethods?: Array<{ id: string; name: string; type?: string }>;
  agentCapabilities?: {
    loadSession?: boolean;
    auth?: { logout?: object | null } | null;
    sessionCapabilities?: { resume?: object | null; close?: object | null; list?: object | null } | null;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean } | null;
    /** Transports beyond stdio. */
    mcpCapabilities?: { http?: boolean; sse?: boolean } | null;
  } | null;
}

export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text: string } };

export interface AcpTimeouts { handshakeMs: number; sessionMs: number; cancelMs: number; signInMs: number }

export interface AcpAgentSessionOptions {
  /** How messages name the agent: `Cursor does not offer …`. */
  agentName: string;
  process: AcpProcess;
  cwd: string;
  clientInfo: { name: string; version: string };
  /** `clientCapabilities` of `initialize`; `fs` handlers are served only when it offers them. */
  clientCapabilities: Record<string, unknown>;
  onUpdate(update: AcpSessionUpdate): void;
  onPermission(request: AcpPermissionRequest): Promise<AcpPermissionResponse>;
  /** A form the agent wants filled; declined without this. */
  onElicitation?(request: AcpElicitationRequest): Promise<AcpElicitationAnswer>;
  onExit?(error: AcpExitedError | undefined): void;
  onStderrLine?(line: string): void;
  /** A notification other than `session/update`: an extension method of the agent's own. */
  onNotification?(method: string, params: unknown): void;
  /** Roots the agent may read and write through Tau; the workspace itself is always one. */
  fileRoots?: readonly string[];
  /** MCP servers forwarded when a session is created, resumed or loaded. */
  mcpServers?: readonly unknown[];
  /** False sends http and sse servers even to an agent that does not list the transport. */
  checkMcpTransports?: boolean;
  timeouts?: Partial<AcpTimeouts>;
}

/** The real path of a directory that may not exist yet: its nearest existing ancestor resolved, the rest appended. */
async function realpathOfNearestAncestor(directory: string): Promise<string> {
  const missing: string[] = [];
  let current = directory;
  for (;;) {
    try {
      const real = await realpath(current);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return directory;
      missing.push(basename(current));
      current = parent;
    }
  }
}

const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUTS: AcpTimeouts = { handshakeMs: 90_000, sessionMs: 90_000, cancelMs: 15_000, signInMs: 300_000 };

/** The select values of a config option, groups flattened. */
export function configOptionValues(option: AcpConfigOption | undefined): AcpSelectOption[] {
  if (!option || option.type !== "select" || !option.options) return [];
  return option.options.flatMap((entry) => "value" in entry ? [entry] : entry.options);
}

export function findConfigOption(options: readonly AcpConfigOption[] | null | undefined, category: "model" | "mode"): AcpConfigOption | undefined {
  return options?.find((option) => option.id === category) ?? options?.find((option) => option.category === category);
}

export class AcpAgentSession {
  protected readonly client: AcpClient;
  protected readonly timeouts: AcpTimeouts;
  private activePrompt?: Promise<AcpPromptResponse>;
  private promptAbort?: AbortController;
  initialized?: AcpInitializeResult;
  setup?: AcpSessionSetup;
  configOptions: AcpConfigOption[] = [];
  modeId: string | undefined = undefined;

  constructor(protected readonly base: AcpAgentSessionOptions) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...base.timeouts };
    this.client = new AcpClient({
      process: base.process,
      agentName: base.agentName,
      onNotification: (method, params) => this.onNotification(method, params),
      onStdoutLine: (line) => this.stdoutLine(line),
      onStderrLine: (line) => this.stderrLine(line),
      onExit: (error) => base.onExit?.(error),
    });
    this.client.handle("session/request_permission", (params) => this.onPermission(params as AcpPermissionRequest));
    // The schema nests the answer under `action`; the SDK's alias answers it flat.
    this.client.handle("session/elicitation", async (params) => ({ action: await this.onElicitation(params as AcpElicitationRequest) }));
    this.client.handle("elicitation/create", (params) => this.onElicitation(params as AcpElicitationRequest));
    const fs = base.clientCapabilities.fs as { readTextFile?: boolean; writeTextFile?: boolean } | undefined;
    if (fs?.readTextFile) this.client.handle("fs/read_text_file", (params) => this.readTextFile(params as { path: string; line?: number | null; limit?: number | null }));
    if (fs?.writeTextFile) this.client.handle("fs/write_text_file", (params) => this.writeTextFile(params as { path: string; content: string }));
  }

  get closed(): boolean { return this.client.closed; }
  get pid(): number | undefined { return this.client.pid; }
  get stderr(): string { return this.client.stderr; }
  get sessionId(): string | undefined { return this.setup?.sessionId; }

  /** A stdout line that is not JSON-RPC; true when it was meant for the kit. */
  protected stdoutLine(_line: string): boolean { return false; }
  protected stderrLine(line: string): void { this.base.onStderrLine?.(line); }
  /** A handshake request that must not outlive something the kit watches for, such as a refused sign-in. */
  protected guarded<T>(request: Promise<T>): Promise<T> { return request; }

  async initialize(): Promise<AcpInitializeResult> {
    this.initialized = await this.guarded(this.client.request<AcpInitializeResult>("initialize", {
      protocolVersion: 1,
      clientCapabilities: this.base.clientCapabilities,
      clientInfo: this.base.clientInfo,
    }, { timeoutMs: this.timeouts.handshakeMs }));
    return this.initialized;
  }

  /** Blocks while the agent completes its sign-in, which may take the user a while. */
  async authenticate(methodId: string): Promise<void> {
    await this.guarded(this.client.request("authenticate", { methodId }, { timeoutMs: this.timeouts.signInMs }));
  }

  /** Answers the agent's requests of an extension method; the last registration wins. */
  handle(method: string, handler: AcpRequestHandler): () => void {
    return this.client.handle(method, handler);
  }

  /** A request of the agent's own (extension) methods. */
  request<T = unknown>(method: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<T> {
    return this.client.request<T>(method, params, { timeoutMs: options.timeoutMs ?? this.timeouts.sessionMs });
  }

  /** ACP lets a client send an http or sse server only to an agent that says it takes that transport. */
  private mcpServers(): unknown[] {
    if (this.base.checkMcpTransports === false) return [...this.base.mcpServers ?? []];
    const transports = this.initialized?.agentCapabilities?.mcpCapabilities;
    return (this.base.mcpServers ?? []).filter((server) => {
      const type = (server as { type?: unknown }).type;
      return type === "http" ? transports?.http === true : type === "sse" ? transports?.sse === true : true;
    });
  }

  async newSession(): Promise<AcpSessionSetup> {
    const setup = await this.guarded(this.client.request<AcpSessionSetup>("session/new", { cwd: this.base.cwd, mcpServers: this.mcpServers() }, { timeoutMs: this.timeouts.sessionMs }));
    this.adopt(setup);
    return setup;
  }

  async resumeSession(sessionId: string): Promise<AcpSessionSetup> {
    if (!this.initialized?.agentCapabilities?.sessionCapabilities?.resume) throw new Error(`${this.base.agentName} does not support resuming a session.`);
    const setup = await this.guarded(this.client.request<Omit<AcpSessionSetup, "sessionId">>("session/resume", { sessionId, cwd: this.base.cwd, mcpServers: this.mcpServers() }, { timeoutMs: this.timeouts.sessionMs }));
    this.adopt({ ...setup, sessionId });
    return this.setup!;
  }

  /**
   * `session/load`: the agent replays the conversation as updates before it
   * answers, so a caller that shows updates ignores them until a prompt runs.
   */
  async loadSession(sessionId: string): Promise<AcpSessionSetup> {
    if (!this.initialized?.agentCapabilities?.loadSession) throw new Error(`${this.base.agentName} does not support loading a session.`);
    const setup = await this.guarded(this.client.request<Omit<AcpSessionSetup, "sessionId"> | null>("session/load", { sessionId, cwd: this.base.cwd, mcpServers: this.mcpServers() }, { timeoutMs: this.timeouts.sessionMs }));
    this.adopt({ ...setup ?? {}, sessionId });
    return this.setup!;
  }

  private adopt(setup: AcpSessionSetup): void {
    this.setup = setup;
    this.configOptions = setup.configOptions ?? [];
    this.modeId = setup.modes?.currentModeId ?? (findConfigOption(this.configOptions, "mode")?.currentValue as string | undefined);
  }

  /** The models the session offers, native ids kept; from the config option, else the model state. */
  modelOptions(): AcpSelectOption[] {
    const option = findConfigOption(this.configOptions, "model");
    if (option) return configOptionValues(option);
    return this.setup?.models?.availableModels.map((model) => ({ value: model.modelId, name: model.name, description: model.description })) ?? [];
  }

  currentModel(): string | undefined {
    const option = findConfigOption(this.configOptions, "model");
    return option ? String(option.currentValue) : this.setup?.models?.currentModelId;
  }

  modeOptions(): AcpSelectOption[] {
    const option = findConfigOption(this.configOptions, "mode");
    if (option) return configOptionValues(option);
    return this.setup?.modes?.availableModes.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description })) ?? [];
  }

  /** Model and mode go through `session/set_config_option`; a select value the session does not list is refused here. */
  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    this.requireSession();
    const option = this.configOptions.find((entry) => entry.id === configId) ?? findConfigOption(this.configOptions, configId as "model" | "mode");
    if (option && option.type === "select") {
      if (String(option.currentValue).trim() === String(value).trim()) return;
      if (!configOptionValues(option).some((entry) => entry.value === value)) throw new AcpRequestError("session/set_config_option", ACP_INVALID_PARAMS, `${this.base.agentName} does not offer "${String(value)}" for ${configId}.`);
    }
    if (option && option.type === "boolean" && option.currentValue === value) return;
    const result = await this.client.request<{ configOptions?: AcpConfigOption[] | null }>("session/set_config_option", { sessionId: this.setup!.sessionId, configId: option?.id ?? configId, value }, { timeoutMs: this.timeouts.sessionMs });
    if (Array.isArray(result.configOptions)) this.configOptions = result.configOptions;
    if (configId === "mode" && typeof value === "string") this.modeId = value;
  }

  /**
   * Through the model config option; an agent that has only the model state takes `session/set_model`.
   * `meta` rides along as `_meta` (an agent's own model settings) and is sent even for the current model.
   */
  async setModel(modelId: string, meta?: Record<string, unknown>): Promise<void> {
    if (findConfigOption(this.configOptions, "model") || !this.setup?.models) return this.setConfigOption("model", modelId);
    if (this.setup.models.currentModelId === modelId && !meta) return;
    if (!this.setup.models.availableModels.some((model) => model.modelId === modelId)) throw new AcpRequestError("session/set_model", ACP_INVALID_PARAMS, `${this.base.agentName} does not offer "${modelId}" for model.`);
    await this.client.request("session/set_model", { sessionId: this.setup.sessionId, modelId, ...(meta ? { _meta: meta } : {}) }, { timeoutMs: this.timeouts.sessionMs });
    this.setup = { ...this.setup, models: { ...this.setup.models, currentModelId: modelId } };
  }

  /** Through the mode config option; an agent that has only the mode state takes `session/set_mode`. */
  async setMode(modeId: string): Promise<void> {
    if (this.modeId === modeId) return;
    if (findConfigOption(this.configOptions, "mode") || !this.setup?.modes) return this.setConfigOption("mode", modeId);
    if (!this.setup.modes.availableModes.some((mode) => mode.id === modeId)) throw new AcpRequestError("session/set_mode", ACP_INVALID_PARAMS, `${this.base.agentName} does not offer "${modeId}" for mode.`);
    await this.client.request("session/set_mode", { sessionId: this.setup.sessionId, modeId }, { timeoutMs: this.timeouts.sessionMs });
    this.modeId = modeId;
  }

  /** One turn; the answer is the agent's stop reason and usage. A second prompt waits for the first. */
  async prompt(blocks: readonly AcpContentBlock[], signal?: AbortSignal, meta?: Record<string, unknown>): Promise<AcpPromptResponse> {
    this.requireSession();
    while (this.activePrompt) await this.activePrompt.catch(() => undefined);
    const abort = new AbortController();
    this.promptAbort = abort;
    const request = this.client.request<AcpPromptResponse>("session/prompt", { sessionId: this.setup!.sessionId, prompt: blocks, ...(meta ? { _meta: meta } : {}) }, { signal: abort.signal });
    this.activePrompt = request;
    const forward = () => abort.abort();
    signal?.addEventListener("abort", forward, { once: true });
    try {
      return await request;
    } finally {
      signal?.removeEventListener("abort", forward);
      if (this.activePrompt === request) { this.activePrompt = undefined; this.promptAbort = undefined; }
    }
  }

  /** Asks the agent to stop the running turn and waits for its answer; a turn that does not stop takes the process down. */
  async cancel(): Promise<void> {
    const active = this.activePrompt;
    if (!active || !this.setup) return;
    this.client.notify("session/cancel", { sessionId: this.setup.sessionId });
    const settled = active.then(() => true, () => true);
    const timeout = new Promise<false>((done) => setTimeout(() => done(false), this.timeouts.cancelMs).unref?.());
    if (!await Promise.race([settled, timeout])) {
      this.promptAbort?.abort();
      await this.close();
    }
  }

  async logout(): Promise<void> {
    if (!this.initialized?.agentCapabilities?.auth?.logout) throw new Error(`${this.base.agentName} offers no sign-out.`);
    await this.client.request("logout", {}, { timeoutMs: this.timeouts.sessionMs });
  }

  async close(): Promise<void> {
    this.promptAbort?.abort();
    await this.client.close();
  }

  private requireSession(): void {
    if (!this.setup) throw new Error(`The ${this.base.agentName} session has not been created.`);
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update") { this.base.onNotification?.(method, params); return; }
    if (!params || typeof params !== "object") return;
    const notification = params as { sessionId?: string; update?: AcpSessionUpdate };
    if (!notification.update || (this.setup && notification.sessionId !== this.setup.sessionId)) return;
    if (notification.update.sessionUpdate === "config_option_update" && Array.isArray(notification.update.configOptions)) this.configOptions = notification.update.configOptions as AcpConfigOption[];
    if (notification.update.sessionUpdate === "current_mode_update" && typeof notification.update.currentModeId === "string") this.modeId = notification.update.currentModeId;
    this.base.onUpdate(notification.update);
  }

  private async onPermission(request: AcpPermissionRequest): Promise<AcpPermissionResponse> {
    if (!this.setup || request.sessionId !== this.setup.sessionId) return { outcome: { outcome: "cancelled" } };
    return this.base.onPermission(request);
  }

  private async onElicitation(request: AcpElicitationRequest): Promise<AcpElicitationAnswer> {
    if (!this.setup || (request.sessionId !== undefined && request.sessionId !== this.setup.sessionId)) return { action: "cancel" };
    if (request.mode !== undefined && request.mode !== "form") return { action: "decline" };
    return this.base.onElicitation ? this.base.onElicitation(request) : { action: "decline" };
  }

  /** A path the agent may touch through Tau: inside the workspace or another root, symlinks on the parent followed. */
  private async containedPath(requested: string): Promise<string> {
    const absolute = isAbsolute(requested) ? resolve(requested) : resolve(this.base.cwd, requested);
    const candidate = join(await realpathOfNearestAncestor(dirname(absolute)), basename(absolute));
    for (const root of [this.base.cwd, ...(this.base.fileRoots ?? [])]) {
      const real = await realpath(root).catch(() => resolve(root));
      if (candidate === real || candidate.startsWith(`${real}${sep}`)) return candidate;
    }
    throw new AcpRequestError("fs/read_text_file", ACP_INVALID_PARAMS, `Path '${requested}' is outside the session workspace.`);
  }

  private async readTextFile(params: { path: string; line?: number | null; limit?: number | null }): Promise<{ content: string }> {
    const path = await this.containedPath(params.path);
    let info;
    try { info = await stat(path); } catch { throw new AcpRequestError("fs/read_text_file", ACP_RESOURCE_NOT_FOUND, `'${params.path}' does not exist.`); }
    if (!info.isFile()) throw new AcpRequestError("fs/read_text_file", ACP_INVALID_PARAMS, `'${params.path}' is not a file.`);
    if (info.size > CLIENT_FILE_MAX_BYTES) throw new AcpRequestError("fs/read_text_file", ACP_INVALID_PARAMS, `'${params.path}' is larger than Tau reads for an agent.`);
    let text: string;
    try { text = await readFile(path, "utf8"); } catch { throw new AcpRequestError("fs/read_text_file", ACP_INTERNAL_ERROR, `Could not read '${params.path}'.`); }
    if (params.line == null && params.limit == null) return { content: text };
    // ACP lines are 1-indexed; `limit` is a line count.
    const lines = text.split("\n");
    const start = Math.max(0, (params.line ?? 1) - 1);
    const end = params.limit == null ? lines.length : Math.min(lines.length, start + params.limit);
    return { content: lines.slice(start, end).join("\n") };
  }

  /** The agent gates each write behind a permission request; only containment is checked here. */
  private async writeTextFile(params: { path: string; content: string }): Promise<object> {
    const path = await this.containedPath(params.path);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, params.content, "utf8");
    } catch {
      throw new AcpRequestError("fs/write_text_file", ACP_INTERNAL_ERROR, `Could not write '${params.path}'.`);
    }
    return {};
  }
}
