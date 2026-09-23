import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { ACP_AUTH_REQUIRED, ACP_INTERNAL_ERROR, ACP_INVALID_PARAMS, ACP_RESOURCE_NOT_FOUND, AcpClient, AcpRequestError, spawnAcpProcess, type AcpExitedError, type AcpProcess, type AcpSpawnInput } from "./acp-client.js";
import type { AcpPromptResponse, AcpSessionUpdate } from "./events.js";
import type { AntigravityExecutable } from "./install.js";
import { agentEnvironment, parseAuthorizationLink, type AntigravityAuthMethod, type AntigravityProfile, type AuthorizationLink } from "./profile.js";
import { ANTIGRAVITY_CLIENT_NAME } from "./protocol.js";

/**
 * One ACP conversation with the Antigravity server: the handshake, one
 * session (new or resumed), prompts, cancellation, and what the agent asks
 * of Tau in between: permissions, and reads and writes inside the workspace,
 * so every edit passes through a permission request first.
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
  models?: { availableModels: Array<{ modelId: string; name: string; description?: string | null }>; currentModelId: string } | null;
  modes?: { availableModes: Array<{ id: string; name: string; description?: string | null }>; currentModeId: string } | null;
}
export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: { name: string; version: string; title?: string | null } | null;
  authMethods?: Array<{ id: string; name: string; type?: string }>;
  agentCapabilities?: {
    loadSession?: boolean;
    auth?: { logout?: object | null } | null;
    sessionCapabilities?: { resume?: object | null; close?: object | null } | null;
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean } | null;
    /** Transports beyond stdio; agy_acp_server 1.1.1 offers both. */
    mcpCapabilities?: { http?: boolean; sse?: boolean } | null;
  } | null;
}

export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text: string } };

export interface AntigravitySessionOptions {
  executable: AntigravityExecutable;
  profile: AntigravityProfile;
  cwd: string;
  platform: string;
  baseEnv: NodeJS.ProcessEnv;
  browser: string;
  clientVersion: string;
  authMethod?: AntigravityAuthMethod;
  /** The chosen method's credential from the user's environment; everything else Google-related is stripped. */
  credentials?: Readonly<Record<string, string>>;
  /** Ends the process, and with it a sign-in that is still waiting for the browser. */
  signal?: AbortSignal;
  spawn?(input: AcpSpawnInput): AcpProcess;
  onUpdate(update: AcpSessionUpdate): void;
  onPermission(request: AcpPermissionRequest): Promise<AcpPermissionResponse>;
  /** A form the agent wants filled; declined without this. */
  onElicitation?(request: AcpElicitationRequest): Promise<AcpElicitationAnswer>;
  /** The sign-in link the agent wants opened; without this the handshake fails when one appears. */
  onSignIn?(link: AuthorizationLink): void;
  onExit?(error: AcpExitedError | undefined): void;
  onStderrLine?(line: string): void;
  /** Roots the agent may read and write through Tau; the workspace itself is always one. */
  fileRoots?: readonly string[];
  /** The user's own MCP servers, forwarded when a session is created or resumed. */
  mcpServers?: readonly unknown[];
  /** False runs `initialize` only, so a sign-out never starts an interactive sign-in. */
  authenticate?: boolean;
  timeouts?: { handshakeMs?: number; sessionMs?: number; cancelMs?: number; signInMs?: number };
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

export const SIGN_IN_REQUIRED = "Sign in to Antigravity with your Google account before you continue.";
const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUTS = { handshakeMs: 90_000, sessionMs: 90_000, cancelMs: 15_000, signInMs: 300_000 };

export function acpSpawnInput(options: Pick<AntigravitySessionOptions, "executable" | "profile" | "cwd" | "platform" | "baseEnv" | "browser" | "credentials">): AcpSpawnInput {
  return {
    command: options.executable.executablePath,
    args: options.platform === "linux" ? ["--uid="] : [],
    cwd: options.cwd,
    env: agentEnvironment(options.baseEnv, options.profile, options.executable.harnessPath, options.browser, options.credentials),
  };
}

/** The select values of a config option, groups flattened. */
export function configOptionValues(option: AcpConfigOption | undefined): AcpSelectOption[] {
  if (!option || option.type !== "select" || !option.options) return [];
  return option.options.flatMap((entry) => "value" in entry ? [entry] : entry.options);
}

export function findConfigOption(options: readonly AcpConfigOption[] | null | undefined, category: "model" | "mode"): AcpConfigOption | undefined {
  return options?.find((option) => option.id === category) ?? options?.find((option) => option.category === category);
}

export class AntigravitySession {
  private readonly client: AcpClient;
  private readonly timeouts: typeof DEFAULT_TIMEOUTS;
  private signInFailure?: Promise<never>;
  private failSignIn?: (error: Error) => void;
  private link?: AuthorizationLink;
  private activePrompt?: Promise<AcpPromptResponse>;
  private promptAbort?: AbortController;
  initialized?: AcpInitializeResult;
  setup?: AcpSessionSetup;
  configOptions: AcpConfigOption[] = [];
  modeId: string | undefined = undefined;

  private constructor(private readonly options: AntigravitySessionOptions) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    const process = (options.spawn ?? spawnAcpProcess)(acpSpawnInput(options));
    this.signInFailure = new Promise<never>((_resolve, reject) => { this.failSignIn = reject; });
    this.signInFailure.catch(() => undefined);
    this.client = new AcpClient({
      process,
      onNotification: (method, params) => this.onNotification(method, params),
      onStdoutLine: (line) => this.onAuthLine(line),
      onStderrLine: (line) => { if (!this.onAuthLine(line)) options.onStderrLine?.(line); },
      onExit: (error) => options.onExit?.(error),
    });
    this.client.handle("session/request_permission", (params) => this.onPermission(params as AcpPermissionRequest));
    // The schema nests the answer under `action`; the SDK's alias answers it flat.
    this.client.handle("session/elicitation", async (params) => ({ action: await this.onElicitation(params as AcpElicitationRequest) }));
    this.client.handle("elicitation/create", (params) => this.onElicitation(params as AcpElicitationRequest));
    this.client.handle("fs/read_text_file", (params) => this.readTextFile(params as { path: string; line?: number | null; limit?: number | null }));
    this.client.handle("fs/write_text_file", (params) => this.writeTextFile(params as { path: string; content: string }));
  }

  /** Spawns the server and runs `initialize` and `authenticate`; a sign-in the agent needs is reported through `onSignIn`. */
  static async open(options: AntigravitySessionOptions): Promise<AntigravitySession> {
    const session = new AntigravitySession(options);
    options.signal?.addEventListener("abort", () => void session.close(), { once: true });
    try {
      session.initialized = await session.guarded(session.client.request<AcpInitializeResult>("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, elicitation: { form: {} } },
        clientInfo: { name: ANTIGRAVITY_CLIENT_NAME, version: options.clientVersion },
      }, { timeoutMs: session.timeouts.handshakeMs }));
      if (options.authenticate === false) return session;
      const methodId = options.authMethod ?? "oauth-personal";
      if (session.initialized.authMethods && !session.initialized.authMethods.some((method) => method.id === methodId)) {
        throw new Error(`Antigravity offers no "${methodId}" sign-in.`);
      }
      // Authenticate blocks while the user completes Google's sign-in in the browser.
      await session.guarded(session.client.request("authenticate", { methodId }, { timeoutMs: session.timeouts.signInMs }));
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  get closed(): boolean { return this.client.closed; }
  get pid(): number | undefined { return this.client.pid; }
  get stderr(): string { return this.client.stderr; }
  get sessionId(): string | undefined { return this.setup?.sessionId; }
  get signInLink(): AuthorizationLink | undefined { return this.link; }

  /** ACP lets a client send an http or sse server only to an agent that says it takes that transport. */
  private mcpServers(): unknown[] {
    const transports = this.initialized?.agentCapabilities?.mcpCapabilities;
    return (this.options.mcpServers ?? []).filter((server) => {
      const type = (server as { type?: unknown }).type;
      return type === "http" ? transports?.http === true : type === "sse" ? transports?.sse === true : true;
    });
  }

  async newSession(): Promise<AcpSessionSetup> {
    const setup = await this.guarded(this.client.request<AcpSessionSetup>("session/new", { cwd: this.options.cwd, mcpServers: this.mcpServers() }, { timeoutMs: this.timeouts.sessionMs }));
    this.adopt(setup);
    return setup;
  }

  async resumeSession(sessionId: string): Promise<AcpSessionSetup> {
    if (!this.initialized?.agentCapabilities?.sessionCapabilities?.resume) throw new Error("Antigravity does not support resuming a session.");
    const setup = await this.guarded(this.client.request<Omit<AcpSessionSetup, "sessionId">>("session/resume", { sessionId, cwd: this.options.cwd, mcpServers: this.mcpServers() }, { timeoutMs: this.timeouts.sessionMs }));
    this.adopt({ ...setup, sessionId });
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

  /** Antigravity takes both model and mode through `session/set_config_option`; a value it does not list is refused here. */
  async setConfigOption(configId: string, value: string): Promise<void> {
    this.requireSession();
    const option = this.configOptions.find((entry) => entry.id === configId) ?? findConfigOption(this.configOptions, configId as "model" | "mode");
    if (option && option.type === "select") {
      if (String(option.currentValue).trim() === value.trim()) return;
      if (!configOptionValues(option).some((entry) => entry.value === value)) throw new AcpRequestError("session/set_config_option", ACP_INVALID_PARAMS, `Antigravity does not offer "${value}" for ${configId}.`);
    }
    const result = await this.client.request<{ configOptions?: AcpConfigOption[] | null }>("session/set_config_option", { sessionId: this.setup!.sessionId, configId: option?.id ?? configId, value }, { timeoutMs: this.timeouts.sessionMs });
    if (Array.isArray(result.configOptions)) this.configOptions = result.configOptions;
    if (configId === "mode") this.modeId = value;
  }

  setModel(modelId: string): Promise<void> { return this.setConfigOption("model", modelId); }
  setMode(modeId: string): Promise<void> {
    if (this.modeId === modeId) return Promise.resolve();
    return this.setConfigOption("mode", modeId);
  }

  /** One turn; the answer is the agent's stop reason and usage. A second prompt waits for the first. */
  async prompt(blocks: readonly AcpContentBlock[], signal?: AbortSignal): Promise<AcpPromptResponse> {
    this.requireSession();
    while (this.activePrompt) await this.activePrompt.catch(() => undefined);
    const abort = new AbortController();
    this.promptAbort = abort;
    const request = this.client.request<AcpPromptResponse>("session/prompt", { sessionId: this.setup!.sessionId, prompt: blocks }, { signal: abort.signal });
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
    if (!this.initialized?.agentCapabilities?.auth?.logout) throw new Error("Antigravity offers no sign-out.");
    await this.client.request("logout", {}, { timeoutMs: this.timeouts.sessionMs });
  }

  async close(): Promise<void> {
    this.promptAbort?.abort();
    await this.client.close();
  }

  private requireSession(): void {
    if (!this.setup) throw new Error("The Antigravity session has not been created.");
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update" || !params || typeof params !== "object") return;
    const notification = params as { sessionId?: string; update?: AcpSessionUpdate };
    if (!notification.update || (this.setup && notification.sessionId !== this.setup.sessionId)) return;
    if (notification.update.sessionUpdate === "config_option_update" && Array.isArray(notification.update.configOptions)) this.configOptions = notification.update.configOptions as AcpConfigOption[];
    if (notification.update.sessionUpdate === "current_mode_update" && typeof notification.update.currentModeId === "string") this.modeId = notification.update.currentModeId;
    this.options.onUpdate(notification.update);
  }

  /** A sign-in link, from stdout or the browser helper on stderr; only Google's own link with a loopback redirect counts. */
  private onAuthLine(line: string): boolean {
    const link = parseAuthorizationLink(line);
    if (!link) return false;
    if (this.link && this.link.state !== link.state) {
      this.failSignIn?.(new Error("Antigravity started more than one Google sign-in request."));
      return true;
    }
    this.link = link;
    if (this.options.onSignIn) this.options.onSignIn(link);
    else this.failSignIn?.(new AcpRequestError("authenticate", ACP_AUTH_REQUIRED, SIGN_IN_REQUIRED));
    return true;
  }

  /** A request that must not outlive a refused sign-in. */
  private guarded<T>(request: Promise<T>): Promise<T> {
    return Promise.race([request, this.signInFailure!]);
  }

  private async onPermission(request: AcpPermissionRequest): Promise<AcpPermissionResponse> {
    if (!this.setup || request.sessionId !== this.setup.sessionId) return { outcome: { outcome: "cancelled" } };
    return this.options.onPermission(request);
  }

  private async onElicitation(request: AcpElicitationRequest): Promise<AcpElicitationAnswer> {
    if (!this.setup || (request.sessionId !== undefined && request.sessionId !== this.setup.sessionId)) return { action: "cancel" };
    if (request.mode !== undefined && request.mode !== "form") return { action: "decline" };
    return this.options.onElicitation ? this.options.onElicitation(request) : { action: "decline" };
  }

  /** A path the agent may touch through Tau: inside the workspace or another root, symlinks on the parent followed. */
  private async containedPath(requested: string): Promise<string> {
    const absolute = isAbsolute(requested) ? resolve(requested) : resolve(this.options.cwd, requested);
    const candidate = join(await realpathOfNearestAncestor(dirname(absolute)), basename(absolute));
    for (const root of [this.options.cwd, ...(this.options.fileRoots ?? [])]) {
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
