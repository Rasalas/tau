import { spawnAcpProcess, type AcpExitedError, type AcpProcess, type AcpSpawnInput } from "../_acp/client.js";
import type { AcpSessionUpdate } from "../_acp/events.js";
import type { AcpMcpServer } from "../_acp/mcp.js";
import { AcpAgentSession, type AcpElicitationAnswer, type AcpElicitationRequest, type AcpPermissionRequest, type AcpPermissionResponse } from "../_acp/session.js";
import type { CursorListedModel } from "./catalog.js";

/**
 * The Cursor CLI's ACP server (`agent acp`): the shared session with
 * Cursor's sign-in method and the capability that makes it list each model
 * once, with its efforts as config options. The agent edits files itself,
 * so Tau offers no file access; permissions come as requests.
 */
export const CURSOR_AUTH_METHOD = "cursor_login";
export const CURSOR_CLIENT_NAME = "tau";
export const SIGN_IN_HINT = "Cursor is not signed in. Run `cursor-agent login` in a terminal, then try again.";

export interface CursorSessionOptions {
  command: string;
  /** The instance's extra launch arguments, placed before `acp`. */
  args?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  clientVersion: string;
  spawn?(input: AcpSpawnInput): AcpProcess;
  onUpdate(update: AcpSessionUpdate): void;
  onPermission(request: AcpPermissionRequest): Promise<AcpPermissionResponse>;
  onElicitation?(request: AcpElicitationRequest): Promise<AcpElicitationAnswer>;
  onNotification?(method: string, params: unknown): void;
  onExit?(error: AcpExitedError | undefined): void;
  onStderrLine?(line: string): void;
  mcpServers?: readonly AcpMcpServer[];
  timeouts?: { handshakeMs?: number; sessionMs?: number; cancelMs?: number; signInMs?: number };
}

export function cursorSpawnInput(options: Pick<CursorSessionOptions, "command" | "args" | "cwd" | "env">): AcpSpawnInput {
  const env = Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  return { command: options.command, args: [...options.args ?? [], "acp"], cwd: options.cwd, env };
}

function signInError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return /auth|log ?in|sign ?in|unauthori[sz]ed/iu.test(message) ? new Error(`${SIGN_IN_HINT}\n${message}`) : error instanceof Error ? error : new Error(message);
}

/** Spawns `agent acp`, shakes hands and signs in with the CLI's stored login; the caller creates or loads the session. */
export async function openCursorSession(options: CursorSessionOptions): Promise<AcpAgentSession> {
  const session = new AcpAgentSession({
    agentName: "Cursor",
    process: (options.spawn ?? spawnAcpProcess)(cursorSpawnInput(options)),
    cwd: options.cwd,
    clientInfo: { name: CURSOR_CLIENT_NAME, version: options.clientVersion },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} }, _meta: { parameterizedModelPicker: true } },
    onUpdate: options.onUpdate,
    onPermission: options.onPermission,
    ...(options.onElicitation ? { onElicitation: options.onElicitation } : {}),
    ...(options.onNotification ? { onNotification: options.onNotification } : {}),
    ...(options.onExit ? { onExit: options.onExit } : {}),
    ...(options.onStderrLine ? { onStderrLine: options.onStderrLine } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    // Cursor takes Tau's http server without listing the transport.
    checkMcpTransports: false,
    timeouts: { signInMs: 60_000, ...options.timeouts },
  });
  try {
    const initialized = await session.initialize();
    if (!initialized.authMethods || initialized.authMethods.some((method) => method.id === CURSOR_AUTH_METHOD)) {
      await session.authenticate(CURSOR_AUTH_METHOD).catch((error: unknown) => { throw signInError(error); });
    }
    return session;
  } catch (error) {
    await session.close();
    throw error;
  }
}

/** The account's models with their efforts, from a session that runs no thread. */
export async function listCursorModels(session: AcpAgentSession): Promise<CursorListedModel[]> {
  const answer = await session.request<{ models?: unknown }>("cursor/list_available_models", {});
  return Array.isArray(answer?.models) ? answer.models.filter((model): model is CursorListedModel => Boolean(model) && typeof (model as CursorListedModel).value === "string") : [];
}
