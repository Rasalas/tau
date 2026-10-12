import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { ExtensionPackageSummary } from "../shared/contracts.js";

/** A filesystem socket or named pipe, never a listener a browser can open. */
function channelPath(userData: string): string {
  const hash = createHash("sha256").update(realpathSync(userData)).digest("hex").slice(0, 24);
  if (process.platform === "win32") return `\\\\.\\pipe\\tau-extension-grants-${hash}`;
  // A short, fixed root keeps service and window environments on the same socket.
  const directory = join("/tmp", `tau-grants-${process.getuid?.() ?? "user"}-${hash}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new Error("Native grant channel directory is not owned by this user.");
  chmodSync(directory, 0o700);
  return join(directory, "window.sock");
}

function readFrames(socket: Duplex, receive: (frame: Record<string, unknown>) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const frame: unknown = JSON.parse(line);
        if (frame && typeof frame === "object" && !Array.isArray(frame)) receive(frame as Record<string, unknown>);
      } catch { /* a malformed local frame authorizes nothing */ }
    }
  });
  socket.on("error", () => socket.destroy());
}

/** Only native peers can answer; the public host protocol never participates. */
export class NativeExtensionGrants {
  private readonly peers = new Set<Duplex>();
  private readonly pending = new Map<string, { socket: Duplex; settle(answer: boolean): void }>();

  attach(socket: Duplex): void {
    this.peers.add(socket);
    readFrames(socket, (frame) => {
      if (typeof frame.id !== "string") return;
      const pending = this.pending.get(frame.id);
      if (pending?.socket === socket) pending.settle(frame.accepted === true);
    });
    socket.on("close", () => {
      this.peers.delete(socket);
      for (const pending of this.pending.values()) if (pending.socket === socket) pending.settle(false);
    });
  }

  confirm(pkg: ExtensionPackageSummary): Promise<boolean | undefined> {
    const socket = [...this.peers].at(-1);
    if (!socket) return Promise.resolve(undefined);
    const id = randomUUID();
    return new Promise<boolean>((resolveAnswer) => {
      const settle = (answer: boolean) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolveAnswer(answer);
      };
      const timer = setTimeout(() => settle(false), 10 * 60_000);
      timer.unref();
      this.pending.set(id, { socket, settle });
      socket.write(`${JSON.stringify({ id, pkg })}\n`);
    });
  }

  close(): void {
    for (const pending of this.pending.values()) pending.settle(false);
    for (const socket of this.peers) socket.destroy();
    this.peers.clear();
  }
}

export async function serveNativeExtensionGrants(userData: string): Promise<Pick<NativeExtensionGrants, "confirm" | "close">> {
  const channel = new NativeExtensionGrants();
  const path = channelPath(userData);
  if (process.platform !== "win32") {
    const info = (() => { try { return lstatSync(path); } catch { return undefined; } })();
    if (info && !info.isSocket()) throw new Error("Native grant channel path is not a socket.");
    rmSync(path, { force: true });
  }
  const server = createServer((socket) => channel.attach(socket));
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.removeListener("error", reject); ready(); });
  });
  return {
    confirm: (pkg) => channel.confirm(pkg),
    close: () => {
      channel.close();
      server.close();
      if (process.platform !== "win32") rmSync(path, { force: true });
    },
  };
}

/** The window's main process owns the dialog and sends its answer on the private pipe. */
export function answerNativeExtensionGrants(socket: Duplex, confirm: (pkg: ExtensionPackageSummary) => Promise<boolean>): void {
  readFrames(socket, (frame) => {
    if (typeof frame.id !== "string" || !frame.pkg || typeof frame.pkg !== "object") return;
    void confirm(frame.pkg as ExtensionPackageSummary).then(
      (accepted) => { if (!socket.destroyed) socket.write(`${JSON.stringify({ id: frame.id, accepted })}\n`); },
      () => { if (!socket.destroyed) socket.write(`${JSON.stringify({ id: frame.id, accepted: false })}\n`); },
    );
  });
}

/** Reconnects when a supervised or service host restarts. */
export function connectNativeExtensionGrants(userData: string, confirm: (pkg: ExtensionPackageSummary) => Promise<boolean>): () => void {
  const path = channelPath(userData);
  let stopped = false;
  let socket: ReturnType<typeof createConnection>;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    socket = createConnection(path);
    answerNativeExtensionGrants(socket, confirm);
    socket.on("close", () => { if (!stopped) { retry = setTimeout(connect, 1000); retry.unref(); } });
  };
  connect();
  return () => { stopped = true; clearTimeout(retry); socket.destroy(); };
}
