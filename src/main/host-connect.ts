import { HOST_FACTORY_COMMANDS } from "../shared/host-factory-commands.js";
import type { HostCommand } from "../shared/host-command-definition.js";
import { bindHostCommand } from "./host-command-handler.js";
import { readFile, mkdir, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pairingUrl } from "../shared/connections.js";
import { encodeConnectOffer, validConnectRoute } from "../shared/managed-connections.js";
import type { ConnectSetup, ConnectStatus } from "../shared/connect.js";
import type { HostMethodTable } from "./host-methods.js";
import { isHostOwner } from "./host-invocation.js";
import { ownerRefusal } from "./host-method-access.js";
import { ConnectHostTunnel, type ConnectHostRoute } from "./connect-tunnel.js";

function registrationFailure(response: Response): Error {
  const status = `HTTP ${response.status}`;
  const message = response.status === 401 || response.status === 403
    ? `The relay refused registration (${status}). Check its enrollment token.`
    : response.status === 504
      ? `The relay timed out before registration completed (${status}). Try again in a few minutes.`
      : `The relay could not complete registration (${status}). Try again later.`;
  const trace = response.headers.get("traceparent")?.split("-");
  const traceId = trace?.length === 4 && /^[a-f0-9]{32}$/iu.test(trace[1] ?? "") ? trace[1] : undefined;
  const requestId = response.headers.get("x-request-id");
  const diagnostics = [
    ...(traceId ? [`Trace ID: ${traceId}.`] : []),
    ...(requestId && /^[a-z0-9._:-]{1,128}$/iu.test(requestId) ? [`Request ID: ${requestId}.`] : []),
  ];
  return new Error([message, ...diagnostics].join(" "));
}

export interface ConnectListener { port: number; publicKey: string; fingerprint: string; close(): Promise<void> }
export interface HostConnectOptions {
  userData: string;
  host: { id: string; name: string };
  listen(): Promise<ConnectListener>;
  createLink(): { code: string };
  fetch?: typeof fetch;
  tunnel?(route: ConnectHostRoute, port: number, publish: (phase: ConnectStatus["phase"], detail?: string) => void): Pick<ConnectHostTunnel, "start" | "close">;
}

/** Registration secrets are host data, like the host token, and never leave status responses. */
export class HostConnect {
  private config?: ConnectHostRoute;
  private tunnel?: Pick<ConnectHostTunnel, "start" | "close">;
  private listener?: ConnectListener;
  private state: ConnectStatus = { phase: "disabled" };
  private work: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly options: HostConnectOptions) {}
  private get path(): string { return join(this.options.userData, "connect.json"); }
  status(): ConnectStatus { return { ...this.state }; }
  async start(): Promise<void> {
    const result = this.work.then(() => this.startNow()); this.work = result.catch(() => undefined); return result;
  }
  private async startNow(): Promise<void> {
    if (this.closed) return;
    let config: ConnectHostRoute;
    try { config = JSON.parse(await readFile(this.path, "utf8")) as ConnectHostRoute; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; this.state = { phase: "offline", detail: "Tau Connect's saved registration could not be read. Configure it again." }; return; }
    if (!validConnectRoute({ relay: config.relay, id: config.id, token: config.clientToken, port: 1 }) || !/^[A-Za-z0-9_-]{43}$/u.test(config.hostToken)) {
      this.state = { phase: "offline", detail: "Tau Connect's saved registration is invalid. Configure it again." }; return;
    }
    if (this.closed) return;
    this.config = config;
    try { await this.open(); }
    catch (error) { this.state = { phase: "offline", relay: config.relay, id: config.id, detail: error instanceof Error ? error.message : String(error) }; throw error; }
  }
  private async open(): Promise<void> {
    if (!this.config || this.closed) return;
    this.listener ??= await this.options.listen();
    if (this.closed) { await this.listener.close(); this.listener = undefined; return; }
    this.tunnel?.close();
    const publish = (phase: ConnectStatus["phase"], detail?: string) => {
      this.state = { phase, relay: this.config?.relay, id: this.config?.id, ...(detail ? { detail } : {}) };
    };
    this.tunnel = this.options.tunnel?.(this.config, this.listener.port, publish) ?? new ConnectHostTunnel(this.config, this.listener.port, publish);
    this.tunnel.start();
  }
  configure(input: ConnectSetup): Promise<ConnectStatus> {
    const run = async () => {
      if (this.closed) throw new Error("This host is shutting down.");
      const relay = new URL(input.relay);
      if (relay.protocol !== "https:" || relay.username || relay.password || relay.search || relay.hash || !/^[A-Za-z0-9_-]{43}$/u.test(input.enrollmentToken)) throw new Error("Use an HTTPS relay address and its enrollment token.");
      if (this.config) throw new Error("Remove this machine's current Tau Connect registration before registering another route.");
      let response: Response;
      try {
        response = await (this.options.fetch ?? fetch)(new URL("/v1/routes", relay), { method: "POST", headers: { Authorization: `Bearer ${input.enrollmentToken}` }, signal: AbortSignal.timeout(15_000), redirect: "error" });
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new Error(`Registration ${error.name === "TimeoutError" ? "timed out" : "was cancelled"} locally before a relay response was received. Try again later.`, { cause: error });
        }
        throw error;
      }
      if (!response.ok) throw registrationFailure(response);
      const record = await response.json() as Omit<ConnectHostRoute, "relay">;
      const config = { ...record, relay: relay.origin };
      if (!validConnectRoute({ relay: config.relay, id: config.id, token: config.clientToken, port: 1 }) || !/^[A-Za-z0-9_-]{43}$/u.test(config.hostToken)) throw new Error("The relay returned an invalid registration.");
      try {
        if (this.closed) throw new Error("This host stopped before registration completed.");
        const temporary = `${this.path}.${randomUUID()}`;
        await mkdir(this.options.userData, { recursive: true, mode: 0o700 });
        try { await writeFile(temporary, JSON.stringify(config), { mode: 0o600 }); await rename(temporary, this.path); }
        finally { await rm(temporary, { force: true }); }
        this.config = config;
        await this.open();
        if (this.closed) throw new Error("This host stopped before registration completed.");
        return this.status();
      } catch (error) {
        this.tunnel?.close(); this.tunnel = undefined;
        await this.listener?.close().catch(() => undefined); this.listener = undefined;
        await rm(this.path, { force: true }).catch(() => undefined); this.config = undefined;
        const revoked = await this.revoke(config);
        throw new Error(`${error instanceof Error ? error.message : String(error)}${revoked ? "" : ` The relay route ${config.id} could not be revoked; delete it using the relay's administration token.`}`, { cause: error });
      }
    };
    const result = this.work.then(run); this.work = result.catch(() => undefined); return result;
  }
  link(): string {
    if (!this.config || !this.listener) throw new Error("Configure Tau Connect first.");
    const { code } = this.options.createLink();
    const page = `https://127.0.0.1:${this.listener.port}/`;
    const link = pairingUrl(page, { code, publicKey: this.listener.publicKey, fingerprint: this.listener.fingerprint, hostId: this.options.host.id, hostName: this.options.host.name });
    return encodeConnectOffer({ version: 1, relay: this.config.relay, id: this.config.id, token: this.config.clientToken, link });
  }
  async remove(): Promise<ConnectStatus> {
    const result = this.work.then(() => this.removeNow()); this.work = result.catch(() => undefined); return result;
  }
  private async revoke(config: ConnectHostRoute): Promise<boolean> {
    try {
      const response = await (this.options.fetch ?? fetch)(new URL(`/v1/routes/${config.id}`, config.relay), { method: "DELETE", headers: { Authorization: `Bearer ${config.hostToken}` }, signal: AbortSignal.timeout(15_000), redirect: "error" });
      return response.ok || response.status === 404;
    } catch { return false; }
  }
  private async removeNow(): Promise<ConnectStatus> {
    let detail: string | undefined;
    // A route the relay already removed has nothing left to revoke.
    if (this.config && this.state.phase !== "removed" && !await this.revoke(this.config)) detail = `Tau Connect stopped locally. The relay could not revoke route ${this.config.id}; delete it using the relay's administration token.`;
    this.tunnel?.close(); this.tunnel = undefined;
    await this.listener?.close(); this.listener = undefined;
    await rm(this.path, { force: true });
    this.config = undefined; this.state = { phase: "disabled", ...(detail ? { detail } : {}) };
    return this.status();
  }
  async close(): Promise<void> { this.closed = true; await this.work.catch(() => undefined); this.tunnel?.close(); await this.listener?.close(); this.listener = undefined; }
}

export function createConnectMethods(service: () => HostConnect | undefined): HostMethodTable {
  const owned = <Args extends readonly unknown[], Result, WireArgs extends readonly unknown[] | never>(
    definition: HostCommand<Args, Result, WireArgs>, run: (connect: HostConnect, params: Args) => Result | Promise<Result>,
  ): HostMethodTable[string] => async (params, context) => {
    if (!isHostOwner(context.principal)) throw ownerRefusal();
    const connect = service();
    if (!connect) throw new Error("Tau Connect is available on this machine's host.");
    return bindHostCommand(definition, (args) => run(connect, args))(params, context);
  };
  return {
    "connect-status": owned(HOST_FACTORY_COMMANDS["connect-status"], async (connect) => connect.status()),
    "connect-configure": owned(HOST_FACTORY_COMMANDS["connect-configure"], async (connect, params) => {
      return connect.configure(params[0]);
    }),
    "connect-link": owned(HOST_FACTORY_COMMANDS["connect-link"], async (connect) => ({ link: connect.link() })),
    "connect-remove": owned(HOST_FACTORY_COMMANDS["connect-remove"], async (connect) => connect.remove()),
  };
}
