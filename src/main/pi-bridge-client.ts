import { readdir, readFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  encodePiBridgeFrame,
  PI_BRIDGE_CLIENT_CAPABILITIES,
  isPiBridgeDescriptor,
  PI_BRIDGE_MAX_FRAME_BYTES,
  PI_BRIDGE_PROTOCOL_VERSION,
  type PiBridgeCommand,
  type PiBridgeDescriptor,
  type PiBridgeServerFrame,
  type PiBridgeSnapshot,
} from "../shared/pi-bridge-protocol.js";

export async function findPiBridge(
  cwd: string,
  sessionFile?: string,
  ownerPid?: number,
): Promise<PiBridgeDescriptor | undefined> {
  const directory = join(getAgentDir(), "tau-bridge", "sessions");
  let names: string[];
  try { names = await readdir(directory); } catch { return undefined; }
  const descriptors = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    try {
      const value: unknown = JSON.parse(await readFile(join(directory, name), "utf8"));
      return isPiBridgeDescriptor(value) ? value : undefined;
    } catch { return undefined; }
  }));
  return descriptors
    .filter((value): value is PiBridgeDescriptor => Boolean(value))
    .filter((value) => ownerPid === undefined || value.pid === ownerPid)
    .filter((value) => sessionFile
      ? resolve(value.sessionFile) === resolve(sessionFile)
      : resolve(value.cwd) === resolve(cwd))
    .sort((left, right) => right.startedAt - left.startedAt)[0];
}

export class PiBridgeReconnectLoop {
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;

  start(attempt: () => Promise<boolean>, onRecovered: () => void, onAttemptError?: (error: unknown) => void): void {
    this.cancel();
    const generation = this.generation;
    let delayMs = 250;
    const run = async () => {
      try {
        if (await attempt()) {
          if (generation === this.generation) onRecovered();
          return;
        }
      } catch (error) {
        onAttemptError?.(error);
      }
      if (generation !== this.generation) return;
      this.timer = setTimeout(() => void run(), delayMs);
      this.timer.unref?.();
      delayMs = Math.min(delayMs * 2, 3_000);
    };
    void run();
  }

  cancel(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class PiBridgeClient {
  private socket?: Socket;
  private buffer = "";
  private requestCounter = 0;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Set<(frame: PiBridgeServerFrame) => void>();
  private disconnectListeners = new Set<(error: Error) => void>();
  private lastSequence = 0;
  private disconnectedNotified = false;
  snapshot?: PiBridgeSnapshot;

  constructor(readonly descriptor: PiBridgeDescriptor) {}

  get isConnected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed && !this.disconnectedNotified);
  }

  async open(timeoutMs = 3_000): Promise<PiBridgeSnapshot> {
    if (this.socket) throw new Error("Pi bridge client is already open.");
    const socket = connect(this.descriptor.socketPath);
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.consume(chunk));
    socket.on("close", () => this.disconnected(new Error("Pi bridge disconnected.")));
    socket.on("error", (error) => this.disconnected(error));
    await new Promise<void>((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error("Pi bridge connection timed out.")), timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolveOpen(); });
      socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
    const id = this.nextId();
    const ready = await new Promise<PiBridgeSnapshot>((resolveReady, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Pi bridge handshake timed out."));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolveReady(value as PiBridgeSnapshot), reject, timer });
      socket.write(encodePiBridgeFrame({
        protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
        type: "hello",
        id,
        epoch: this.descriptor.epoch,
        token: this.descriptor.token,
        expectedSessionId: this.descriptor.sessionId,
        capabilities: PI_BRIDGE_CLIENT_CAPABILITIES,
      }));
    });
    this.snapshot = ready;
    return ready;
  }

  subscribe(listener: (frame: PiBridgeServerFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async command(command: PiBridgeCommand, timeoutMs = 15_000): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("Pi bridge is not connected.");
    const id = this.nextId();
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi bridge command '${command.command}' timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      socket.write(encodePiBridgeFrame({
        protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
        type: "command",
        id,
        epoch: this.descriptor.epoch,
        expectedSessionId: this.descriptor.sessionId,
        ...command,
      }));
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.failPending(new Error("Pi bridge closed."));
    this.listeners.clear();
    this.disconnectListeners.clear();
  }

  private nextId(): string { return `tau-${Date.now()}-${++this.requestCounter}`; }

  private consume(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > PI_BRIDGE_MAX_FRAME_BYTES) {
      this.socket?.destroy(new Error("Pi bridge frame exceeds the size limit."));
      return;
    }
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let frame: PiBridgeServerFrame;
      try { frame = JSON.parse(line) as PiBridgeServerFrame; }
      catch { this.socket?.destroy(new Error("Pi bridge sent invalid JSON.")); return; }
      if (frame.protocolVersion !== PI_BRIDGE_PROTOCOL_VERSION || frame.epoch !== this.descriptor.epoch) continue;
      if (frame.type === "ready") {
        const pending = this.pending.get(frame.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(frame.id);
          pending.resolve(frame.snapshot);
        }
        continue;
      }
      if (frame.type === "response") {
        const pending = this.pending.get(frame.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(frame.id);
        if (frame.ok) pending.resolve(frame.result);
        else pending.reject(new Error(frame.error));
        continue;
      }
      if (frame.seq <= this.lastSequence) continue;
      this.lastSequence = frame.seq;
      if (frame.type === "snapshot") this.snapshot = frame.snapshot;
      for (const listener of this.listeners) listener(frame);
    }
  }

  private disconnected(error: Error): void {
    if (this.disconnectedNotified) return;
    this.disconnectedNotified = true;
    this.failPending(error);
    for (const listener of this.disconnectListeners) listener(error);
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
