import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerHostExtension, WorkerHostExtensionContext } from "tau/host";
import type { UiNetworkAccess } from "tau/host-extension";
import {
  describeFailure,
  otherServes,
  parseServeConfig,
  parseStatus,
  runCli,
  tauServePort,
  type RunCli,
  type ServePort,
  type TailscaleStatus,
} from "./cli.js";
import {
  DEFAULT_HTTPS_PORT,
  TAILSCALE_EXTENSION_ID,
  serveUrl,
  type TailscaleState,
  type TailscaleView,
} from "./protocol.js";

const STATUS_TIMEOUT_MS = 5_000;
const SERVE_TIMEOUT_MS = 20_000;
const STORE_FILE = "serve.json";
const STORE_VERSION = 1;

/** Where the CLI lives when it is not on PATH: inside the macOS app, and the Windows installer's folder. */
const FALLBACK_COMMANDS: Record<string, string> = {
  darwin: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  win32: "C:\\Program Files\\Tailscale\\tailscale.exe",
};

/** The mapping Tau set up (or found) and keeps its proxy listener and endpoint for. */
interface ServeRecord {
  httpsPort: number;
  dnsName: string;
}

export interface TailscaleHostOptions {
  run?: RunCli;
  platform?: string;
  env?: NodeJS.ProcessEnv;
}

function refused(message: string): Error {
  return Object.assign(new Error(message), { expected: true });
}

function decodeRecord(value: unknown): ServeRecord | undefined {
  const { version, httpsPort, dnsName } = (value ?? {}) as Record<string, unknown>;
  if (version !== STORE_VERSION || typeof dnsName !== "string" || !dnsName) return undefined;
  return typeof httpsPort === "number" && Number.isInteger(httpsPort) && httpsPort > 0 && httpsPort < 65536 ? { httpsPort, dnsName } : undefined;
}

function decodeServeOn(input: unknown): { httpsPort: number; name: string } {
  const { httpsPort, name } = (input ?? {}) as Record<string, unknown>;
  if (typeof httpsPort !== "number" || !Number.isInteger(httpsPort) || httpsPort < 1 || httpsPort > 65535) throw refused("The HTTPS port must be a whole number from 1 to 65535.");
  if (typeof name !== "string" || !name) throw refused("Setting up Serve needs the machine name you agreed to publish.");
  return { httpsPort, name };
}

/**
 * Tailscale HTTPS for Tau: finds the CLI, reads `tailscale status --json`, and
 * on the owner's word has `tailscale serve` forward `https://<machine>.ts.net`
 * to the host's loopback proxy listener. While that mapping stands the kit
 * holds the proxy listener open and publishes the URL as an endpoint.
 */
class TailscaleKit {
  private record: ServeRecord | undefined;
  /** Whether this kit keeps the proxy listener open, across restarts too. */
  private kept = false;
  private withdraw: (() => void) | undefined;
  private publishedUrl: string | undefined;
  private notice: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly run: RunCli;
  private readonly platform: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly context: WorkerHostExtensionContext, options: TailscaleHostOptions) {
    this.run = options.run ?? runCli;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
  }

  private get services() {
    return this.context.services;
  }

  /** Brings the proxy listener and the endpoint back from the last run, without asking the CLI anything. */
  start(): Promise<void> {
    return this.serialize(async () => {
      const stored = decodeRecord(await readFile(join(this.services.stateDir, STORE_FILE), "utf8").then((text) => JSON.parse(text) as unknown, () => undefined));
      try {
        // The host may still keep the listener for a mapping this kit no longer records; say which is true.
        await this.services.network.keepProxy(stored !== undefined);
        this.kept = stored !== undefined;
        if (stored) await this.follow(stored);
      } catch (error: unknown) {
        this.services.log("tailscale.restore-failed", messageOf(error));
      }
    });
  }

  /** The kept proxy listener stays: Serve still forwards after Tau quits, and the next start opens it before any kit runs. */
  stop(): void {
    this.withdraw?.();
    this.withdraw = undefined;
  }

  status(): Promise<TailscaleView> {
    return this.serialize(() => this.look());
  }

  serveOn(input: unknown): Promise<TailscaleView> {
    const { httpsPort, name } = decodeServeOn(input);
    return this.serialize(async () => {
      const seen = await this.read();
      if (seen.state !== "running" || !seen.command || !seen.status || !seen.network) throw refused(this.blocker(seen.state));
      const { dnsName, magicDns, https } = seen.status;
      if (!dnsName || !magicDns) throw refused("MagicDNS is off in your tailnet. Turn it on in the admin console’s DNS page first.");
      if (!https) throw refused("HTTPS certificates are off in your tailnet. Turn them on in the admin console’s DNS page first.");
      if (dnsName !== name) throw refused(`This machine is now called ${dnsName}. Read the question again: that is the name that would be published.`);
      if (!seen.ports) throw refused("Tau could not read what Tailscale Serve forwards already, so it changes nothing.");
      const proxyPort = seen.network.settings.proxyPort;
      const current = tauServePort(seen.ports, proxyPort, this.record?.httpsPort);
      if (current !== undefined && current !== httpsPort) throw refused(`Serve already forwards port ${current} to Tau. Turn Tailscale HTTPS off first to move it.`);
      const taken = otherServes(seen.ports, proxyPort).find((other) => other.httpsPort === httpsPort && (other.path === "/" || other.path === ""));
      if (taken) throw refused(`Serve already forwards ${serveUrl(dnsName, httpsPort)} to ${taken.target}. Pick another port, or remove that first.`);

      const keptBefore = this.kept;
      await this.keep(true);
      const letGo = async () => {
        if (!keptBefore && !this.record) await this.keep(false);
      };
      const network = await this.services.network.state();
      if (!network?.listeners.some((listener) => listener.kind === "proxy")) {
        await letGo();
        throw refused(network?.problems.find((problem) => problem.includes(String(proxyPort))) ?? `Tau’s proxy listener on 127.0.0.1:${proxyPort} did not open.`);
      }
      if (current === undefined) {
        const target = `http://127.0.0.1:${proxyPort}`;
        this.services.log("tailscale.serve-on", `--https=${httpsPort} ${target}`);
        const result = await this.run(seen.command, ["serve", "--bg", `--https=${httpsPort}`, target], SERVE_TIMEOUT_MS);
        if (result.code !== 0) {
          await letGo();
          throw refused(describeFailure(result, this.platform));
        }
      }
      this.notice = undefined;
      await this.follow({ httpsPort, dnsName });
      return this.look();
    });
  }

  serveOff(): Promise<TailscaleView> {
    return this.serialize(async () => {
      const seen = await this.read();
      const proxyPort = seen.network?.settings.proxyPort;
      if (seen.ports && proxyPort !== undefined) {
        const port = tauServePort(seen.ports, proxyPort, this.record?.httpsPort);
        if (port !== undefined && seen.command) {
          this.services.log("tailscale.serve-off", `--https=${port} --set-path=/`);
          // Only Tau's `/`: anything else on that port stays.
          const result = await this.run(seen.command, ["serve", `--https=${port}`, "--set-path=/", "off"], SERVE_TIMEOUT_MS);
          if (result.code !== 0) throw refused(describeFailure(result, this.platform));
        }
      } else if (this.record) {
        throw refused(seen.state === "running"
          ? "Tau could not read Tailscale Serve’s settings, so it removed nothing."
          : `${this.blocker(seen.state)} Tau cannot remove the mapping until then.`);
      }
      this.notice = undefined;
      await this.follow(undefined);
      return this.look();
    });
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private blocker(state: TailscaleState): string {
    switch (state) {
      case "no-host-network": return "This host opens no listeners of its own.";
      case "not-installed": return "Tailscale is not installed on this machine.";
      case "needs-login": return "Tailscale is signed out on this machine.";
      case "not-running": return "Tailscale is not connected on this machine.";
      default: return "";
    }
  }

  private async command(): Promise<string | undefined> {
    const override = this.env.TAU_TAILSCALE_COMMAND?.trim();
    // An explicit command stands alone: a test's fake never falls through to the real CLI.
    if (override) return override;
    const found = await this.services.findCommand("tailscale");
    if (found) return found;
    const fallback = FALLBACK_COMMANDS[this.platform];
    return fallback ? this.services.findCommand(fallback) : undefined;
  }

  /** One fresh read: the host's network, the CLI's status, and Serve's settings when they matter. */
  private async read(): Promise<{ state: TailscaleState; network?: UiNetworkAccess; command?: string; status?: TailscaleStatus; ports?: ServePort[] }> {
    const network = await this.services.network.state();
    if (!network) return { state: "no-host-network" };
    const command = await this.command();
    if (!command) return { state: "not-installed", network };
    const result = await this.run(command, ["status", "--json"], STATUS_TIMEOUT_MS);
    if (result.failedToStart) return { state: "not-installed", network };
    const status = parseStatus(result.stdout);
    if (!status) return { state: "not-running", network, command };
    if (status.state !== "running" || !status.dnsName) return { state: status.state, network, command, status };
    // Serve's settings are read only once HTTPS can work or Tau already has a mapping.
    if (!status.https && !this.record) return { state: "running", network, command, status };
    const serve = await this.run(command, ["serve", "status", "--json"], STATUS_TIMEOUT_MS);
    const ports = serve.code === 0 ? parseServeConfig(serve.stdout, status.dnsName) : undefined;
    return { state: "running", network, command, status, ...(ports ? { ports } : {}) };
  }

  /** Reads, follows what Serve actually does, and answers the view. */
  private async look(): Promise<TailscaleView> {
    const seen = await this.read();
    const proxyPort = seen.network?.settings.proxyPort ?? 0;
    if (seen.ports && seen.status?.dnsName) {
      const port = tauServePort(seen.ports, proxyPort, this.record?.httpsPort);
      if (port !== undefined) {
        if (!this.record) this.notice = "Tailscale Serve already forwarded to Tau, so Tau uses that.";
        await this.follow({ httpsPort: port, dnsName: seen.status.dnsName });
      } else if (this.record) {
        this.notice = "Serve no longer forwards to Tau: it was turned off outside Tau.";
        await this.follow(undefined);
      }
    }
    const network = seen.network ?? await this.services.network.state();
    const record = this.record;
    return {
      state: seen.state,
      ...(seen.status?.backendState ? { backendState: seen.status.backendState } : {}),
      ...(seen.status?.dnsName ? { dnsName: seen.status.dnsName } : {}),
      magicDns: seen.status?.magicDns ?? false,
      https: seen.status?.https ?? false,
      proxyPort,
      proxyListening: network?.listeners.some((listener) => listener.kind === "proxy") ?? false,
      serve: {
        on: record !== undefined,
        httpsPort: record?.httpsPort ?? DEFAULT_HTTPS_PORT,
        ...(record ? { url: serveUrl(record.dnsName, record.httpsPort) } : {}),
        others: seen.ports ? otherServes(seen.ports, proxyPort) : [],
      },
      ...(this.notice ? { notice: this.notice } : {}),
      platform: this.platform,
    };
  }

  private async keep(keep: boolean): Promise<void> {
    if (keep === this.kept) return;
    await this.services.network.keepProxy(keep);
    this.kept = keep;
  }

  /** Holds the proxy listener, publishes the URL and keeps the record while a mapping stands; lets go of all three after. */
  private async follow(next: ServeRecord | undefined): Promise<void> {
    await this.keep(next !== undefined);
    const url = next ? serveUrl(next.dnsName, next.httpsPort) : undefined;
    if (url !== this.publishedUrl) {
      this.withdraw?.();
      this.withdraw = url ? await this.services.network.publishEndpoints([
        { url, label: "Tailscale HTTPS", reachability: "network", kind: "magicdns", trustedCertificate: true },
      ]) : undefined;
      this.publishedUrl = url;
    }
    if (next?.httpsPort === this.record?.httpsPort && next?.dnsName === this.record?.dnsName) return;
    const path = join(this.services.stateDir, STORE_FILE);
    if (next) {
      await mkdir(this.services.stateDir, { recursive: true });
      await writeFile(path, `${JSON.stringify({ version: STORE_VERSION, ...next })}\n`, { mode: 0o600 });
    } else {
      await rm(path, { force: true });
    }
    this.record = next;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createTailscaleHostExtension(options: TailscaleHostOptions = {}): WorkerHostExtension {
  return {
    id: TAILSCALE_EXTENSION_ID,
    name: "Tailscale",
    activate(context) {
      const kit = new TailscaleKit(context, options);
      void kit.start();
      context.registerCommand("status", () => kit.status(), { access: "owner" });
      context.registerCommand("serve-on", (input) => kit.serveOn(input), { long: true, access: "owner" });
      context.registerCommand("serve-off", () => kit.serveOff(), { long: true, access: "owner" });
      return () => kit.stop();
    },
  };
}

export default createTailscaleHostExtension;
