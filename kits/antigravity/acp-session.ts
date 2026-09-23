import { ACP_AUTH_REQUIRED, AcpRequestError, spawnAcpProcess, type AcpExitedError, type AcpProcess, type AcpSpawnInput } from "../_acp/client.js";
import type { AcpSessionUpdate } from "../_acp/events.js";
import { AcpAgentSession, type AcpElicitationAnswer, type AcpElicitationRequest, type AcpPermissionRequest, type AcpPermissionResponse } from "../_acp/session.js";
import type { AntigravityExecutable } from "./install.js";
import { agentEnvironment, parseAuthorizationLink, type AntigravityAuthMethod, type AntigravityProfile, type AuthorizationLink } from "./profile.js";
import { ANTIGRAVITY_CLIENT_NAME } from "./protocol.js";

export {
  configOptionValues,
  findConfigOption,
  type AcpConfigOption,
  type AcpContentBlock,
  type AcpElicitationAnswer,
  type AcpElicitationRequest,
  type AcpInitializeResult,
  type AcpPermissionOption,
  type AcpPermissionRequest,
  type AcpPermissionResponse,
  type AcpSelectOption,
  type AcpSessionSetup,
} from "../_acp/session.js";

/**
 * One ACP conversation with the Antigravity server: the shared session
 * (`kits/_acp/session.ts`) with Google's sign-in on top. The agent reads and
 * writes inside the workspace through Tau, so every edit passes through a
 * permission request first.
 */
export interface AntigravitySessionOptions {
  executable: AntigravityExecutable;
  profile: AntigravityProfile;
  cwd: string;
  platform: string;
  baseEnv: NodeJS.ProcessEnv;
  browser: string;
  clientVersion: string;
  authMethod?: AntigravityAuthMethod;
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

export const SIGN_IN_REQUIRED = "Sign in to Antigravity with your Google account before you continue.";

export function acpSpawnInput(options: Pick<AntigravitySessionOptions, "executable" | "profile" | "cwd" | "platform" | "baseEnv" | "browser">): AcpSpawnInput {
  return {
    command: options.executable.executablePath,
    args: options.platform === "linux" ? ["--uid="] : [],
    cwd: options.cwd,
    env: agentEnvironment(options.baseEnv, options.profile, options.executable.harnessPath, options.browser),
  };
}

export class AntigravitySession extends AcpAgentSession {
  private readonly signInFailure: Promise<never>;
  private failSignIn?: (error: Error) => void;
  private link?: AuthorizationLink;

  private constructor(private readonly options: AntigravitySessionOptions) {
    super({
      agentName: "Antigravity",
      process: (options.spawn ?? spawnAcpProcess)(acpSpawnInput(options)),
      cwd: options.cwd,
      clientInfo: { name: ANTIGRAVITY_CLIENT_NAME, version: options.clientVersion },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false, elicitation: { form: {} } },
      onUpdate: options.onUpdate,
      onPermission: options.onPermission,
      ...(options.onElicitation ? { onElicitation: options.onElicitation } : {}),
      ...(options.onExit ? { onExit: options.onExit } : {}),
      ...(options.fileRoots ? { fileRoots: options.fileRoots } : {}),
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
      ...(options.timeouts ? { timeouts: options.timeouts } : {}),
    });
    this.signInFailure = new Promise<never>((_resolve, reject) => { this.failSignIn = reject; });
    this.signInFailure.catch(() => undefined);
  }

  /** Spawns the server and runs `initialize` and `authenticate`; a sign-in the agent needs is reported through `onSignIn`. */
  static async open(options: AntigravitySessionOptions): Promise<AntigravitySession> {
    const session = new AntigravitySession(options);
    try {
      await session.initialize();
      if (options.authenticate === false) return session;
      const methodId = options.authMethod ?? "oauth-personal";
      if (session.initialized!.authMethods && !session.initialized!.authMethods.some((method) => method.id === methodId)) {
        throw new Error(`Antigravity offers no "${methodId}" sign-in.`);
      }
      // Authenticate blocks while the user completes Google's sign-in in the browser.
      await session.authenticate(methodId);
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  get signInLink(): AuthorizationLink | undefined { return this.link; }

  protected override stdoutLine(line: string): boolean { return this.onAuthLine(line); }
  protected override stderrLine(line: string): void { if (!this.onAuthLine(line)) this.options.onStderrLine?.(line); }
  protected override guarded<T>(request: Promise<T>): Promise<T> { return Promise.race([request, this.signInFailure]); }

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
}
