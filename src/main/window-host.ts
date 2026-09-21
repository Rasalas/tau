import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DesktopExtensionLoadResult, HostEvent } from "../shared/contracts.js";
import { isHostUpdate } from "../shared/host-protocol.js";
import type { HostPush } from "../shared/host-transport.js";
import type { HostLogger } from "./host-log.js";
import { HostProcessSupervisor, type RunningHost } from "./host-process-supervisor.js";
import { HostUplink } from "./host-uplink.js";
import { WindowExtensionRegistry } from "./window-extensions.js";

/** Compiling every kit on a cold cache takes longer than a click does. */
const UPLINK_TIMEOUT_MS = 180_000;

export interface WindowHostOptions {
  userData: string;
  /** Tau's version; a host of another one is replaced rather than adopted. */
  version: string;
  /** Root of the built app: `dist-electron/main/headless.js` lives under it. */
  mainDirectory: string;
  /** Electron's own binary, which the host runs as plain Node. */
  execPath: string;
  workspace?: string;
  logger: HostLogger;
  /** The host is gone for good; the window says so with the log path. */
  onFatal(failure: { message: string; logPath: string }): void;
  /** The host came back on another port; the window has to reload its client. */
  onUrlChanged(url: string): void;
  /** Pushes the window process itself acts on, not the ones the renderer reads. */
  onEvent?(event: HostEvent): void;
}

/**
 * The host, seen from the window's process: a supervised child process or a
 * host somebody else is running, plus the one connection this process needs of
 * its own. The renderer speaks the protocol for itself over a socket; what is
 * left here is the work only a window can do — serving kit bundles, knowing
 * which workspace is open, and ending the host on quit (ADR 0021).
 */
export class WindowHost {
  private supervisor: HostProcessSupervisor | undefined;
  private uplink: HostUplink | undefined;
  private url = "";
  private token = "";
  private workspace: string;
  /** The halves of the kits that need this process; the host calls into them. */
  readonly extensions: WindowExtensionRegistry;

  constructor(private readonly options: WindowHostOptions) {
    this.workspace = options.workspace ?? "";
    this.extensions = new WindowExtensionRegistry({
      invokeHost: (extensionId, command, input) => this.request("host-extension", [extensionId, command, input]),
      logger: options.logger,
    });
  }

  get hostUrl(): string { return this.url; }
  get hostToken(): string { return this.token; }
  get logFile(): string { return this.supervisor?.logFile ?? ""; }
  /** The workspace the host last published; a packaged rebuild looks for a checkout there. */
  get activeWorkspace(): string { return this.workspace; }

  /** Starts (or adopts) the host process and opens this window's own connection. */
  async startSupervised(): Promise<RunningHost> {
    const supervisor = new HostProcessSupervisor({
      entry: headlessEntry(this.options.mainDirectory),
      execPath: this.options.execPath,
      userData: this.options.userData,
      version: this.options.version,
      logger: this.options.logger,
      ...(this.options.workspace ? { workspace: this.options.workspace } : {}),
      onFatal: (failure) => this.options.onFatal(failure),
      onUrlChanged: (url) => {
        this.url = url;
        this.connect();
        this.options.onUrlChanged(url);
      },
    });
    this.supervisor = supervisor;
    const running = await supervisor.start();
    this.url = running.url;
    this.token = running.token;
    this.connect();
    return running;
  }

  /** Attaches to a host somebody else runs (`TAU_HOST_URL`). Nothing is supervised. */
  attach(url: string, token: string | undefined): void {
    this.url = url;
    this.token = token ?? "";
    this.connect();
  }

  /** One call on this process's own connection; the renderer has its own. */
  async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    if (!this.uplink) throw new Error("This window has no connection to a host.");
    return this.uplink.request<T>(method, params);
  }

  /**
   * The kits, compiled by the host and served by this window. A window at a
   * host in another process cannot import the host's files, so the bundles
   * travel over the protocol and `DesktopBundleStore` becomes their cache.
   */
  async loadDesktopExtensions(
    cwd: string,
    sharedExports: Record<string, string[]>,
    serve: (result: DesktopExtensionLoadResult) => DesktopExtensionLoadResult,
  ): Promise<DesktopExtensionLoadResult> {
    const result = await this.request<DesktopExtensionLoadResult>("desktop-extensions", [cwd, sharedExports]);
    return serve(result);
  }

  /** Ends the host, or leaves it running when the user asked for that. */
  async stop(keepRunning: boolean): Promise<void> {
    this.extensions.dispose();
    this.uplink?.close();
    this.uplink = undefined;
    if (!this.supervisor) return;
    if (keepRunning) {
      this.supervisor.detach();
      this.options.logger.info("host-process.left-running");
      return;
    }
    await this.supervisor.stop();
  }

  /** Runs one call the host made into this process and reports back. */
  private async answer(callId: string, extensionId: string, command: string, input: unknown): Promise<void> {
    try {
      const result = await this.extensions.invoke(extensionId, command, input);
      await this.request("client-call-result", [callId, result]);
    } catch (error: unknown) {
      await this.request("client-call-result", [callId, undefined, error instanceof Error ? error.message : String(error)])
        .catch(() => undefined);
    }
  }

  private connect(): void {
    this.uplink?.close();
    this.uplink = new HostUplink({
      url: this.url,
      token: this.token,
      logger: this.options.logger,
      requestTimeoutMs: UPLINK_TIMEOUT_MS,
      onPush: (push) => this.receive(push),
    });
  }

  private receive(push: HostPush): void {
    const event = push.event as HostEvent;
    if (typeof (event as { type?: unknown }).type !== "string") return;
    if (event.type === "client-call") {
      void this.answer(event.callId, event.extensionId, event.command, event.input);
      return;
    }
    // The host names the open workspace in every project update it publishes.
    if (event.type === "host-update" && isHostUpdate(event.update) && event.update.type === "project") {
      const project = event.update.project as { displayPath?: string; cwd?: string };
      this.workspace = project.displayPath || project.cwd || this.workspace;
    }
    this.options.onEvent?.(event);
  }
}

/**
 * The host entry beside this file. Packaged, the archive has a copy and
 * `asarUnpack` has the real file; the real one is what a child process reads.
 */
export function headlessEntry(mainDirectory: string): string {
  const entry = join(mainDirectory, "headless.js");
  const unpacked = entry.replace(`app.asar${sepOf(entry)}`, `app.asar.unpacked${sepOf(entry)}`);
  return unpacked !== entry && existsSync(unpacked) ? unpacked : entry;
}

function sepOf(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}
