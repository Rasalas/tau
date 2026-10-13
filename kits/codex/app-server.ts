import { MCP_APP_EXTENSION_ID, MCP_APP_MIME_TYPE } from "./mcp-app-protocol.js";
import { RpcConnection, spawnRpcProcess, type RpcClosedError, type RpcProcess, type RpcSpawnInput } from "./rpc.js";

/**
 * The part of `codex app-server`'s v2 protocol Tau speaks: the handshake,
 * account and models, one thread started or resumed, and its turns. Field
 * names are the CLI's own (`codex app-server generate-ts` prints them).
 */

export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type SandboxPolicy = { type: "readOnly"; networkAccess?: boolean } | { type: "workspaceWrite"; networkAccess?: boolean } | { type: "dangerFullAccess" };

/** The name Codex sees as its client, and as the originator of its requests. */
export const CODEX_CLIENT_NAME = "tau";

export interface CodexPolicy {
  approvalPolicy: ApprovalPolicy;
  /** `auto_review`: Codex's own reviewer answers the approvals. Sent every time, so leaving `auto` hands them back to the user. */
  approvalsReviewer?: "user" | "auto_review";
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

export interface CodexServiceTier {
  id: string;
  name: string;
  description?: string;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description?: string }>;
  inputModalities?: string[];
  serviceTiers?: CodexServiceTier[];
  additionalSpeedTiers?: string[];
  defaultServiceTier?: string | null;
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
  thread: { id: string; path?: string | null; cliVersion?: string; name?: string | null };
  model: string;
  reasoningEffort: string | null;
}

/** `thread/goal/*` (codex-cli 0.160: `features.goals`, stable). Timestamps are the CLI's. */
export type CodexGoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
export interface CodexGoal {
  threadId: string;
  objective: string;
  status: CodexGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

/** `mcpServer/resource/read`: the contents as the MCP server answered them. */
export interface CodexMcpResourceRead {
  contents: Array<{ uri?: unknown; mimeType?: unknown; text?: unknown; blob?: unknown; _meta?: unknown }>;
  originCallId?: string | null;
}

/** `mcpServer/tool/call`: an MCP `CallToolResult`. */
export interface CodexMcpToolResult {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}

/** An MCP `Tool` as `mcpServerStatus/list` carries it; only the parts Tau reads are named. */
export interface CodexMcpTool {
  name?: string;
  annotations?: unknown;
  _meta?: unknown;
  [key: string]: unknown;
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

const MCP_RESOURCE_READ_MS = 20_000;
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
        clientInfo: { name: CODEX_CLIENT_NAME, title: "Tau", version: options.clientVersion },
        // Plan mode is experimental. MCP app approvals use OpenAI forms;
        // keep the legacy opt-in for older supported app-server versions.
        capabilities: {
          experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: true,
          extensions: { [MCP_APP_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
        },
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

  /**
   * The account's quota windows, read without changing anything on the
   * account, including its banked reset credits.
   */
  async rateLimits(): Promise<unknown> {
    return this.connection.request("account/rateLimits/read", { excludeResetCreditDetails: false }, { timeoutMs: this.timeouts.requestMs });
  }

  /** Redeems one provider-selected banked reset; retries keep the same key. */
  async consumeResetCredit(idempotencyKey: string): Promise<unknown> {
    return this.connection.request("account/rateLimitResetCredit/consume", { idempotencyKey }, { timeoutMs: 20_000 });
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

  async startThread(params: { cwd: string; model?: string; serviceTier?: string | null; policy: CodexPolicy; ephemeral?: boolean; baseInstructions?: string }): Promise<CodexThreadInfo> {
    let config: Record<string, unknown> | undefined;
    if (params.ephemeral) {
      const result = await this.connection.request<{ config: { mcp_servers?: Record<string, unknown> } }>("config/read", { includeLayers: false, cwd: params.cwd }, { timeoutMs: this.timeouts.requestMs });
      // Empty tables merge with the user's servers, so disable each effective entry.
      config = {
        mcp_servers: Object.fromEntries(Object.keys(result.config.mcp_servers ?? {}).map((name) => [name, { enabled: false }])),
        "features.plugins": false, "features.apps": false,
        "features.shell_tool": false, "features.apply_patch_tool": false,
      };
    }
    return this.connection.request("thread/start", {
      cwd: params.cwd,
      approvalPolicy: params.policy.approvalPolicy,
      approvalsReviewer: params.policy.approvalsReviewer ?? "user",
      sandbox: params.policy.sandbox,
      ...(params.ephemeral ? { ephemeral: true, config, developerInstructions: "Return the requested text only. Do not use tools or inspect the workspace." } : {}),
      ...(params.baseInstructions ? { baseInstructions: params.baseInstructions } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.serviceTier !== undefined ? { serviceTier: params.serviceTier } : {}),
    }, { timeoutMs: this.timeouts.requestMs });
  }

  /** Loads a stored thread; the history stays with the CLI, Tau keeps its own transcript. */
  resumeThread(params: { threadId: string; cwd: string; model?: string; serviceTier?: string | null; policy: CodexPolicy }): Promise<CodexThreadInfo> {
    return this.connection.request("thread/resume", {
      threadId: params.threadId,
      cwd: params.cwd,
      approvalPolicy: params.policy.approvalPolicy,
      approvalsReviewer: params.policy.approvalsReviewer ?? "user",
      sandbox: params.policy.sandbox,
      excludeTurns: true,
      ...(params.model ? { model: params.model } : {}),
      ...(params.serviceTier !== undefined ? { serviceTier: params.serviceTier } : {}),
    }, { timeoutMs: this.timeouts.requestMs });
  }

  async startTurn(params: { threadId: string; input: CodexUserInput[]; policy: CodexPolicy; model?: string; serviceTier?: string | null; effort?: string; mode?: CodexCollaborationMode }): Promise<string> {
    const result = await this.connection.request<{ turn: { id: string } }>("turn/start", {
      threadId: params.threadId,
      input: params.input,
      approvalPolicy: params.policy.approvalPolicy,
      approvalsReviewer: params.policy.approvalsReviewer ?? "user",
      sandboxPolicy: params.policy.sandboxPolicy,
      ...(params.model ? { model: params.model } : {}),
      ...(params.serviceTier !== undefined ? { serviceTier: params.serviceTier } : {}),
      ...(params.effort ? { effort: params.effort } : {}),
      ...(params.mode ? { collaborationMode: params.mode } : {}),
    }, { timeoutMs: this.timeouts.requestMs });
    return result.turn.id;
  }

  async setServiceTier(threadId: string, serviceTier: string | null): Promise<void> {
    await this.connection.request("thread/settings/update", { threadId, serviceTier }, { timeoutMs: this.timeouts.requestMs });
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.connection.request("thread/name/set", { threadId, name }, { timeoutMs: this.timeouts.requestMs });
  }

  /** Adds input to the running turn; the CLI refuses when that turn is no longer the one expected. */
  async steerTurn(params: { threadId: string; turnId: string; input: CodexUserInput[] }): Promise<void> {
    await this.connection.request("turn/steer", { threadId: params.threadId, input: params.input, expectedTurnId: params.turnId }, { timeoutMs: this.timeouts.requestMs });
  }

  async goalGet(threadId: string): Promise<CodexGoal | undefined> {
    const result = await this.connection.request<{ goal: CodexGoal | null }>("thread/goal/get", { threadId }, { timeoutMs: this.timeouts.requestMs });
    return result.goal ?? undefined;
  }

  /** Sets what is named: a new objective, a status, or both. */
  async goalSet(params: { threadId: string; objective?: string; status?: CodexGoalStatus }): Promise<CodexGoal> {
    const result = await this.connection.request<{ goal: CodexGoal }>("thread/goal/set", params, { timeoutMs: this.timeouts.requestMs });
    return result.goal;
  }

  async goalClear(threadId: string): Promise<boolean> {
    const result = await this.connection.request<{ cleared: boolean }>("thread/goal/clear", { threadId }, { timeoutMs: this.timeouts.requestMs });
    return result.cleared;
  }

  /** Experimental in codex-cli 0.162; answers whether the terminal is gone. */
  async terminateBackgroundTerminal(threadId: string, processId: string): Promise<boolean> {
    const result = await this.connection.request<{ terminated?: boolean }>("thread/backgroundTerminals/terminate", { threadId, processId }, { timeoutMs: this.timeouts.requestMs });
    return result.terminated !== false;
  }

  /** Reads a resource through the thread's MCP connection to `server`. */
  readMcpResource(params: { threadId: string; server: string; uri: string; originCallId?: string }): Promise<CodexMcpResourceRead> {
    return this.connection.request("mcpServer/resource/read", params, { timeoutMs: MCP_RESOURCE_READ_MS });
  }

  callMcpTool(params: { threadId: string; server: string; tool: string; arguments?: unknown }): Promise<CodexMcpToolResult> {
    return this.connection.request("mcpServer/tool/call", params, { timeoutMs: this.timeouts.requestMs });
  }

  /** The tools `server` offers this thread, by name; empty when the server is unknown. */
  async listMcpTools(threadId: string, server: string): Promise<Record<string, CodexMcpTool>> {
    const result = await this.connection.request<{ data?: Array<{ name?: string; tools?: Record<string, CodexMcpTool> }> }>("mcpServerStatus/list", { threadId, serverName: server, detail: "toolsAndAuthOnly" }, { timeoutMs: this.timeouts.requestMs });
    return result.data?.find((entry) => entry.name === server)?.tools ?? {};
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.connection.request("turn/interrupt", { threadId, turnId }, { timeoutMs: this.timeouts.requestMs });
  }

  close(): Promise<void> {
    return this.connection.close();
  }
}
