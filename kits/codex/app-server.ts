import { RpcConnection, spawnRpcProcess, type RpcClosedError, type RpcProcess, type RpcSpawnInput } from "./rpc.js";

/**
 * The part of `codex app-server`'s v2 protocol Tau speaks: the handshake,
 * account and models, one thread started or resumed, and its turns. Field
 * names are the CLI's own (`codex app-server generate-ts` prints them).
 */

export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type SandboxPolicy = { type: "readOnly" } | { type: "workspaceWrite" } | { type: "dangerFullAccess" };

export interface CodexPolicy {
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxMode;
  sandboxPolicy: SandboxPolicy;
}

/**
 * Codex's collaboration mode for a turn: `plan` explores and proposes, `default`
 * works. Null instructions take Codex's own for the mode.
 */
export interface CodexCollaborationMode {
  mode: "plan" | "default";
  settings: { model: string; reasoning_effort: string | null; developer_instructions: null };
}

export type CodexUserInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string };

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description?: string }>;
  inputModalities?: string[];
}

export type CodexAccount =
  | { type: "chatgpt"; email: string | null; planType: string }
  | { type: "apiKey" }
  | { type: string };

/** How a login starts: the browser, a device code, or a key handed over. */
export type CodexLoginRequest = { type: "chatgpt" } | { type: "chatgptDeviceCode" } | { type: "apiKey"; apiKey: string };

/** What the CLI answers: the page to open or the code to enter, and the id its `account/login/completed` names. */
export type CodexLoginStart =
  | { type: "chatgpt"; loginId: string; authUrl: string }
  | { type: "chatgptDeviceCode"; loginId: string; verificationUrl: string; userCode: string }
  | { type: "apiKey" };

/** `account/login/completed`: `loginId` is null for a login no flow started (an API key). */
export interface CodexLoginCompleted {
  loginId: string | null;
  success: boolean;
  error: string | null;
}

export interface CodexThreadInfo {
  thread: { id: string; path?: string | null; cliVersion?: string };
  model: string;
  reasoningEffort: string | null;
}

export interface CodexInitializeResult {
  userAgent: string;
  codexHome: string;
  platformOs?: string;
}

export interface CodexSessionOptions {
  command: string;
  /** `app-server` options before any subcommand, e.g. `-c` overrides. */
  args?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  clientVersion: string;
  spawn?(input: RpcSpawnInput): RpcProcess;
  onNotification(method: string, params: unknown): void;
  /** The server's requests: approvals and questions. */
  onRequest(method: string, params: unknown): Promise<unknown>;
  onExit?(error: RpcClosedError | undefined): void;
  onStderrLine?(line: string): void;
  timeouts?: { handshakeMs?: number; requestMs?: number };
}

const DEFAULT_TIMEOUTS = { handshakeMs: 60_000, requestMs: 60_000 };
/** The CLI answers a resume of a thread it has no rollout for with this. */
export const MISSING_THREAD = /no rollout found|thread[^\n]*(?:not found|does not exist|unknown)/iu;

export function spawnInput(command: string, cwd: string, env: NodeJS.ProcessEnv, args: readonly string[] = []): RpcSpawnInput {
  return { command, args: ["app-server", ...args], cwd, env };
}

export class CodexAppServer {
  readonly connection: RpcConnection;
  private readonly timeouts: typeof DEFAULT_TIMEOUTS;
  initialized?: CodexInitializeResult;

  private constructor(private readonly options: CodexSessionOptions) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    const process = (options.spawn ?? spawnRpcProcess)(spawnInput(options.command, options.cwd, options.env, options.args));
    this.connection = new RpcConnection({
      process,
      onNotification: options.onNotification,
      onRequest: options.onRequest,
      ...(options.onStderrLine ? { onStderrLine: options.onStderrLine } : {}),
      ...(options.onExit ? { onExit: options.onExit } : {}),
    });
  }

  /** Spawns `codex app-server` and runs the handshake. */
  static async open(options: CodexSessionOptions): Promise<CodexAppServer> {
    const server = new CodexAppServer(options);
    try {
      server.initialized = await server.connection.request<CodexInitializeResult>("initialize", {
        clientInfo: { name: "tau", title: "Tau", version: options.clientVersion },
        // Collaboration modes (plan) are behind the experimental API.
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, { timeoutMs: server.timeouts.handshakeMs });
      server.connection.notify("initialized");
      return server;
    } catch (error) {
      await server.close();
      throw error;
    }
  }

  get closed(): boolean { return this.connection.closed; }
  get stderr(): string { return this.connection.stderr; }
  get codexHome(): string | undefined { return this.initialized?.codexHome; }

  async account(): Promise<CodexAccount | undefined> {
    const result = await this.connection.request<{ account: CodexAccount | null }>("account/read", { refreshToken: false }, { timeoutMs: this.timeouts.requestMs });
    return result.account ?? undefined;
  }

  /** Starts a login; the CLI keeps the credential in its home and runs any callback listener itself. */
  loginStart(request: CodexLoginRequest): Promise<CodexLoginStart> {
    return this.connection.request("account/login/start", request, { timeoutMs: this.timeouts.requestMs });
  }

  async loginCancel(loginId: string): Promise<void> {
    await this.connection.request("account/login/cancel", { loginId }, { timeoutMs: this.timeouts.requestMs });
  }

  /** Removes what the CLI stored for its login. */
  async logout(): Promise<void> {
    await this.connection.request("account/logout", undefined, { timeoutMs: this.timeouts.requestMs });
  }

  /** Every model the account may pick, hidden ones left out. */
  async models(): Promise<CodexModel[]> {
    const models: CodexModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const result: { data: CodexModel[]; nextCursor: string | null } = await this.connection.request("model/list", cursor ? { cursor } : {}, { timeoutMs: this.timeouts.requestMs });
      models.push(...result.data.filter((model) => !model.hidden));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return models;
  }

  startThread(params: { cwd: string; model?: string; policy: CodexPolicy }): Promise<CodexThreadInfo> {
    return this.connection.request("thread/start", {
      cwd: params.cwd,
      approvalPolicy: params.policy.approvalPolicy,
      sandbox: params.policy.sandbox,
      ...(params.model ? { model: params.model } : {}),
    }, { timeoutMs: this.timeouts.requestMs });
  }

  /** Loads a stored thread; the history stays with the CLI, Tau keeps its own transcript. */
  resumeThread(params: { threadId: string; cwd: string; model?: string; policy: CodexPolicy }): Promise<CodexThreadInfo> {
    return this.connection.request("thread/resume", {
      threadId: params.threadId,
      cwd: params.cwd,
      approvalPolicy: params.policy.approvalPolicy,
      sandbox: params.policy.sandbox,
      excludeTurns: true,
      ...(params.model ? { model: params.model } : {}),
    }, { timeoutMs: this.timeouts.requestMs });
  }

  async startTurn(params: { threadId: string; input: CodexUserInput[]; policy: CodexPolicy; model?: string; effort?: string; mode?: CodexCollaborationMode }): Promise<string> {
    const result = await this.connection.request<{ turn: { id: string } }>("turn/start", {
      threadId: params.threadId,
      input: params.input,
      approvalPolicy: params.policy.approvalPolicy,
      sandboxPolicy: params.policy.sandboxPolicy,
      ...(params.model ? { model: params.model } : {}),
      ...(params.effort ? { effort: params.effort } : {}),
      ...(params.mode ? { collaborationMode: params.mode } : {}),
    }, { timeoutMs: this.timeouts.requestMs });
    return result.turn.id;
  }

  /** Adds input to the running turn; the CLI refuses when that turn is no longer the one expected. */
  async steerTurn(params: { threadId: string; turnId: string; input: CodexUserInput[] }): Promise<void> {
    await this.connection.request("turn/steer", { threadId: params.threadId, input: params.input, expectedTurnId: params.turnId }, { timeoutMs: this.timeouts.requestMs });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.connection.request("turn/interrupt", { threadId, turnId }, { timeoutMs: this.timeouts.requestMs });
  }

  close(): Promise<void> {
    return this.connection.close();
  }
}
