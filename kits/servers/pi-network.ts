import type { ExtensionFactory, ToolCallEvent, ToolCallEventResult, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { HostExecutionPolicy, RuntimeSessionInfo } from "tau/host-extension";

/** The part of `@anthropic-ai/sandbox-runtime`'s `SandboxManager` this kit drives. */
export interface SandboxManagerLike {
  initialize(config: SandboxRuntimeConfigLike): Promise<void>;
  updateConfig(config: SandboxRuntimeConfigLike): void;
  wrapWithSandbox(command: string): Promise<string>;
  reset(): Promise<void>;
}

export interface SandboxRuntimeConfigLike {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    strictAllowlist: boolean;
    allowLocalBinding: boolean;
    allowAllUnixSockets: boolean;
  };
  filesystem: { denyRead: string[]; allowWrite: string[]; denyWrite: string[]; disabled: boolean };
  ripgrep?: { command: string };
}

export type SandboxWrap = { command: string } | { refusal: string };

export interface NetworkSandboxOptions {
  /** `services.loadDependency("@anthropic-ai/sandbox-runtime")`. */
  load(): Promise<unknown>;
  platform?: NodeJS.Platform;
  /** ripgrep's path: sandbox-runtime checks for it on Linux even when no file rule needs it. */
  ripgrep?(): string | undefined;
  log?(label: string, detail?: string): void;
}

function sandboxManagerOf(module: unknown): SandboxManagerLike {
  const manager = (module as { SandboxManager?: SandboxManagerLike } | undefined)?.SandboxManager;
  if (!manager || typeof manager.wrapWithSandbox !== "function" || typeof manager.initialize !== "function") throw new Error("sandbox-runtime has no SandboxManager this build knows");
  return manager;
}

/**
 * Pi's commands held to a project's network limit by `@anthropic-ai/sandbox-runtime`
 * (sandbox-exec on macOS, bubblewrap on Linux): loopback is open, outside
 * hosts go through its proxy, which lets only the allowed hosts through.
 * Files stay as open as without it; only the network is limited.
 *
 * The library keeps one proxy per process, so its allowlist is the union of
 * every limited project's list that ran a command since the kit started.
 */
export class NetworkSandbox {
  private manager?: Promise<SandboxManagerLike>;
  private readonly hostsByCwd = new Map<string, readonly string[]>();
  private appliedHosts = "";
  private readonly platform: NodeJS.Platform;

  constructor(private readonly options: NetworkSandboxOptions) {
    this.platform = options.platform ?? process.platform;
  }

  /** Why Pi's commands cannot be held to a limit here, or nothing when they can. */
  private unsupported(): string | undefined {
    if (this.platform === "darwin" || this.platform === "linux") return undefined;
    return this.platform === "win32" ? "Tau has no sandbox for Windows" : `Tau has no sandbox for ${this.platform}`;
  }

  private config(): SandboxRuntimeConfigLike {
    const hosts = [...new Set([...this.hostsByCwd.values()].flat())].sort();
    const ripgrep = this.options.ripgrep?.();
    return {
      network: { allowedDomains: hosts, deniedDomains: [], strictAllowlist: true, allowLocalBinding: true, allowAllUnixSockets: true },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [], disabled: true },
      ...(ripgrep ? { ripgrep: { command: ripgrep } } : {}),
    };
  }

  private ready(): Promise<SandboxManagerLike> {
    this.manager ??= (async () => {
      const manager = sandboxManagerOf(await this.options.load());
      try {
        await manager.initialize(this.config());
      } catch (error) {
        await manager.reset().catch(() => undefined);
        throw error;
      }
      this.appliedHosts = JSON.stringify(this.config().network.allowedDomains);
      return manager;
    })();
    // A machine that lacked bubblewrap may have it by the next command.
    const pending = this.manager;
    pending.catch(() => { if (this.manager === pending) this.manager = undefined; });
    return pending;
  }

  /** Whether commands can be held to a limit on this machine, for Settings. */
  async availability(): Promise<{ available: boolean; reason?: string }> {
    const reason = this.unsupported();
    if (reason) return { available: false, reason };
    try {
      await this.ready();
      return { available: true };
    } catch (error) {
      return { available: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** The command as it runs under `policy`: unchanged without a limit, wrapped with one, refused when it cannot be wrapped. */
  async wrap(cwd: string, command: string, policy: HostExecutionPolicy): Promise<SandboxWrap> {
    if (policy.network === "any") return { command };
    const why = policy.reasons.length ? policy.reasons.join(" ") : "This project's commands may reach only this machine.";
    const unsupported = this.unsupported();
    if (unsupported) return { refusal: `${why} ${unsupported}, so Tau did not run this command.` };
    this.hostsByCwd.set(cwd, policy.allowHosts);
    try {
      const manager = await this.ready();
      const config = this.config();
      const hosts = JSON.stringify(config.network.allowedDomains);
      if (hosts !== this.appliedHosts) {
        manager.updateConfig(config);
        this.appliedHosts = hosts;
      }
      return { command: await manager.wrapWithSandbox(command) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.log?.("servers.network.sandbox-failed", message);
      return { refusal: `${why} Tau could not start the sandbox that holds commands to it (${message}), so it did not run this command.` };
    }
  }

  async dispose(): Promise<void> {
    const manager = this.manager;
    this.manager = undefined;
    if (!manager) return;
    await manager.then((ready) => ready.reset(), () => undefined).catch(() => undefined);
  }
}

export const NETWORK_NOTE = "[Tau] This command ran with the project's network limit: this machine and the allowed hosts only.";

/**
 * Pi's half: every `bash` call of a limited project runs inside the sandbox.
 * The call is rewritten in the `tool_call` hook, so the transcript keeps the
 * command the model wrote; a failed one gets a line saying why the network
 * may have refused it.
 */
export function createPiNetworkExtension(options: {
  policy(cwd: string): Promise<HostExecutionPolicy>;
  sandbox: Pick<NetworkSandbox, "wrap">;
}): (pi: Parameters<ExtensionFactory>[0], session: RuntimeSessionInfo) => void {
  return (pi, session) => {
    const wrapped = new Set<string>();
    pi.on("tool_call", async (event: ToolCallEvent): Promise<ToolCallEventResult | undefined> => {
      if (event.toolName !== "bash" && event.toolName !== "powershell") return undefined;
      const input = event.input as { command?: unknown };
      if (typeof input.command !== "string") return undefined;
      const policy = await options.policy(session.cwd);
      if (policy.network === "any") return undefined;
      if (event.toolName === "powershell") return { block: true, reason: `${policy.reasons.join(" ")} PowerShell cannot be held to it, so Tau did not run this command.`.trim() };
      const result = await options.sandbox.wrap(session.cwd, input.command, policy);
      if ("refusal" in result) return { block: true, reason: result.refusal };
      input.command = result.command;
      wrapped.add(event.toolCallId);
      return undefined;
    });
    pi.on("tool_result", (event: ToolResultEvent) => {
      if (!wrapped.delete(event.toolCallId) || !event.isError) return undefined;
      return { content: [...event.content, { type: "text" as const, text: NETWORK_NOTE }] };
    });
  };
}
