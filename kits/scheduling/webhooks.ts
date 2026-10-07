import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostCommandError, SecurityKeychain, SecretToolStore, type SecretStore } from "tau/host-extension";

export const SECRET_SERVICE = "tau-webhook-signatures";
export const DELIVERY_WINDOW_MS = 5 * 60_000;

/** Reuses the instance's OS-store stubs; production never falls back to a file. */
export function webhookSecretStore(findCommand: (name: string) => string | undefined): SecretStore | undefined {
  if (process.platform === "darwin") return new SecurityKeychain(process.env.TAU_SERVERS_SECURITY_COMMAND ?? "/usr/bin/security");
  if (process.platform === "linux") {
    const command = process.env.TAU_SERVERS_SECRET_TOOL_COMMAND ?? findCommand("secret-tool");
    return command ? new SecretToolStore(command) : undefined;
  }
  return undefined;
}

export interface WebhookDelivery { id: string; timestamp: number; body: Buffer; signature: string }

/** Timestamp and ID are signed as well as the body, so neither can be replayed or substituted. */
export function verifyDelivery(delivery: WebhookDelivery, secret: string, now = Date.now()): boolean {
  if (!/^[a-f0-9]{64}$/u.test(delivery.signature) || Math.abs(now - delivery.timestamp) > DELIVERY_WINDOW_MS) return false;
  const expected = createHmac("sha256", secret).update(`${delivery.timestamp}\n${delivery.id}\n`).update(delivery.body).digest();
  return timingSafeEqual(expected, Buffer.from(delivery.signature, "hex"));
}

async function readDelivery(request: IncomingMessage): Promise<WebhookDelivery> {
  const id = request.headers["x-tau-delivery"];
  const time = request.headers["x-tau-timestamp"];
  const signature = request.headers["x-tau-signature"];
  if (typeof id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/u.test(id) || typeof time !== "string" || !/^\d{13}$/u.test(time) || typeof signature !== "string") throw new HostCommandError("Missing signed delivery headers.");
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_048_576) throw new HostCommandError("Webhook body exceeds 1 MiB.");
    chunks.push(Buffer.from(chunk));
  }
  return { id, timestamp: Number(time), signature, body: Buffer.concat(chunks) };
}

/** An opt-in loopback endpoint. Opening the host to a network remains the owner's choice. */
export class WebhookListener {
  private server?: Server;
  private serial: Promise<void> = Promise.resolve();
  private stopped = false;
  url?: string;
  constructor(private readonly directory: string, private readonly receive: (jobId: string, delivery: WebhookDelivery) => Promise<number>, private readonly changed: () => void) {}

  reconcile(enabled: boolean): Promise<void> {
    const next = this.serial.catch(() => undefined).then(async () => {
      if (this.stopped || !enabled) { await this.closeServer(); return; }
      if (this.server) return;
      const portFile = join(this.directory, "webhook-port");
      const raw = await readFile(portFile, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return "0"; });
      const port = Number(raw.trim());
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new HostCommandError("Invalid saved webhook port.");
      const server = createServer((request, response) => {
        const finish = (status: number) => { request.resume(); response.writeHead(status, { "content-type": "text/plain", "cache-control": "no-store" }); response.end(status === 202 ? "accepted" : status === 200 ? "already accepted" : "not accepted"); };
        const match = /^\/webhooks\/([a-f0-9-]{36})$/u.exec(request.url ?? "");
        if (request.method !== "POST" || !match) { finish(404); return; }
        void readDelivery(request).then((delivery) => this.receive(match[1]!, delivery)).then(finish, () => finish(400));
      });
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
      server.maxConnections = 16;
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
      server.on("error", () => { this.url = undefined; this.changed(); });
      this.server = server;
      const address = server.address();
      if (!address || typeof address === "string") throw new HostCommandError("Webhook endpoint did not open.");
      try { await writeFile(portFile, String(address.port), { mode: 0o600 }); }
      catch (error) { await this.closeServer(); throw error; }
      this.url = `http://127.0.0.1:${address.port}/webhooks`;
      this.changed();
    });
    this.serial = next;
    return next;
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.url = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); this.changed(); }
  }

  async close(): Promise<void> { this.stopped = true; await this.serial.catch(() => undefined); await this.closeServer(); }
}
