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

export interface ConnectListener { port: number; publicKey: string; fingerprint: string; close(): Promise<void> }
export interface HostConnectOptions {
  userData: string;
  host: { id: string; name: string };
  listen(): Promise<ConnectListener>;
  createLink(): { code: string };
  fetch?: typeof fetch;
}

/** Registration secrets are host data, like the host token, and never leave status responses. */
export class HostConnect {
  private config?: ConnectHostRoute;
  private tunnel?: ConnectHostTunnel;
  private listener?: ConnectListener;
  private state: ConnectStatus = { phase: "disabled" };
  private work: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: HostConnectOptions) {}
  private get path(): string { return join(this.options.userData, "connect.json"); }
  status(): ConnectStatus { return { ...this.state }; }
  async start(): Promise<void> {
    let config: ConnectHostRoute;
    try { config = JSON.parse(await readFile(this.path, "utf8")) as ConnectHostRoute; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; this.state = { phase: "offline", detail: "Tau Connect's saved registration could not be read. Configure it again." }; return; }
    if (!validConnectRoute({ relay: config.relay, id: config.id, token: config.clientToken, port: 1 }) || !/^[A-Za-z0-9_-]{43}$/u.test(config.hostToken)) {
      this.state = { phase: "offline", detail: "Tau Connect's saved registration is invalid. Configure it again." }; return;
    }
    this.config = config;
    await this.open();
  }
  private async open(): Promise<void> {
    if (!this.config) return;
    this.listener ??= await this.options.listen();
    this.tunnel?.close();
    this.tunnel = new ConnectHostTunnel(this.config, this.listener.port, (phase, detail) => {
      this.state = { phase, relay: this.config?.relay, id: this.config?.id, ...(detail ? { detail } : {}) };
    });
    this.tunnel.start();
  }
  configure(input: ConnectSetup): Promise<ConnectStatus> {
    const run = async () => {
      const relay = new URL(input.relay);
      if (relay.protocol !== "https:" || relay.username || relay.password || relay.search || relay.hash || !/^[A-Za-z0-9_-]{43}$/u.test(input.enrollmentToken)) throw new Error("Use an HTTPS relay address and its enrollment token.");
      if (this.config) throw new Error("Remove this machine's current Tau Connect registration before registering another route.");
      const response = await (this.options.fetch ?? fetch)(new URL("/v1/routes", relay), { method: "POST", headers: { Authorization: `Bearer ${input.enrollmentToken}` }, signal: AbortSignal.timeout(15_000), redirect: "error" });
      if (!response.ok) throw new Error(`The relay refused registration (${response.status}). Check its enrollment token.`);
      const record = await response.json() as Omit<ConnectHostRoute, "relay">;
      const config = { ...record, relay: relay.origin };
      if (!validConnectRoute({ relay: config.relay, id: config.id, token: config.clientToken, port: 1 }) || !/^[A-Za-z0-9_-]{43}$/u.test(config.hostToken)) throw new Error("The relay returned an invalid registration.");
      const temporary = `${this.path}.${randomUUID()}`;
      await mkdir(this.options.userData, { recursive: true, mode: 0o700 });
      try { await writeFile(temporary, JSON.stringify(config), { mode: 0o600 }); await rename(temporary, this.path); }
      finally { await rm(temporary, { force: true }); }
      this.config = config;
      await this.open();
      return this.status();
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
    let detail: string | undefined;
    if (this.config) {
      try {
        const response = await (this.options.fetch ?? fetch)(new URL(`/v1/routes/${this.config.id}`, this.config.relay), { method: "DELETE", headers: { Authorization: `Bearer ${this.config.hostToken}` }, signal: AbortSignal.timeout(15_000), redirect: "error" });
        if (!response.ok && response.status !== 404) throw new Error("Relay rejected revocation");
      } catch { detail = "Tau Connect stopped locally. The relay could not revoke this route; delete it using the relay's administration token."; }
    }
    this.tunnel?.close(); this.tunnel = undefined;
    await this.listener?.close(); this.listener = undefined;
    await rm(this.path, { force: true });
    this.config = undefined; this.state = { phase: "disabled", ...(detail ? { detail } : {}) };
    return this.status();
  }
  async close(): Promise<void> { this.tunnel?.close(); await this.listener?.close(); }
}

export function createConnectMethods(service: () => HostConnect | undefined): HostMethodTable {
  const owned = (run: (connect: HostConnect, params: readonly unknown[]) => Promise<unknown>): HostMethodTable[string] => async (params, context) => {
    if (!isHostOwner(context.principal)) throw ownerRefusal();
    const connect = service();
    if (!connect) throw new Error("Tau Connect is available on this machine's host.");
    return run(connect, params);
  };
  return {
    "connect-status": owned(async (connect) => connect.status()),
    "connect-configure": owned(async (connect, params) => {
      const input = params[0] as ConnectSetup | undefined;
      if (typeof input?.relay !== "string" || typeof input.enrollmentToken !== "string" || input.relay.length > 2_048 || input.enrollmentToken.length > 128) throw new Error("Tau Connect requires a relay address and enrollment token.");
      return connect.configure(input);
    }),
    "connect-link": owned(async (connect) => ({ link: connect.link() })),
    "connect-remove": owned(async (connect) => connect.remove()),
  };
}
