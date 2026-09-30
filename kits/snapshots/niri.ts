import { createConnection, type Socket } from "node:net";
import { isAbsolute } from "node:path";

const TIMEOUT = 5_000;
const MAX_REPLY = 4 * 1024 * 1024;
type Json = Record<string, unknown>;
export interface NiriWindow { id: number; title: string | null; app_id: string | null; pid: number | null; layout: { window_size: [number, number] } }

export function niriWindow(value: unknown): NiriWindow {
  const w = value as NiriWindow | undefined;
  if (!w || !Number.isSafeInteger(w.id) || w.id < 0 || ![w.title, w.app_id].every((s) => s === null || typeof s === "string") ||
    !(w.pid === null || Number.isSafeInteger(w.pid) && w.pid > 0) || !Array.isArray(w.layout?.window_size) ||
    w.layout.window_size.length !== 2 || !w.layout.window_size.every((size) => Number.isFinite(size) && size > 0)) throw new Error("Niri returned invalid window metadata.");
  return w;
}

/** One connection per exchange. EventStream requires a second socket for commands. */
export class NiriConnection {
  private readonly socket: Socket;
  private readonly waiters = new Set<{ read: (value: Json) => void; fail: (error: Error) => void }>();
  private failure?: Error;

  constructor(path: string) {
    if (!isAbsolute(path)) throw new Error("Niri's socket path must be absolute.");
    this.socket = createConnection(path);
    this.socket.setEncoding("utf8");
    let pending = "";
    this.socket.on("data", (chunk: string) => {
      pending += chunk;
      if (Buffer.byteLength(pending) > MAX_REPLY) return this.close(new Error("Niri returned an oversized reply."));
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const value = JSON.parse(line) as Json;
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid reply");
          if (typeof value.Err === "string") { this.close(new Error(`Niri: ${value.Err}`)); return; }
          for (const waiter of [...this.waiters]) waiter.read(value);
        } catch { this.close(new Error("Niri returned an invalid reply.")); return; }
      }
    });
    this.socket.on("error", (error) => this.close(error));
    this.socket.on("close", () => this.close(new Error("Niri disconnected.")));
  }

  wait<T>(select: (value: Json) => T | undefined): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); this.waiters.delete(waiter); };
      const waiter = { read: (value: Json) => {
        try { const answer = select(value); if (answer !== undefined) { finish(); resolve(answer); } }
        catch (error) { waiter.fail(error instanceof Error ? error : new Error(String(error))); }
      }, fail: (error: Error) => { finish(); reject(error); } };
      const timer = setTimeout(() => waiter.fail(new Error("Niri capture timed out.")), TIMEOUT);
      this.waiters.add(waiter);
    });
  }

  send(value: unknown): void { this.socket.write(`${JSON.stringify(value)}\n`); }
  close(error = new Error("Niri connection closed.")): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of [...this.waiters]) waiter.fail(error);
    this.socket.destroy();
  }
}

export async function niriRequest(path: string, message: unknown): Promise<Json> {
  const connection = new NiriConnection(path);
  try {
    const response = connection.wait((reply) => {
      if (!("Ok" in reply)) throw new Error("Niri returned no successful reply.");
      return { value: reply.Ok };
    });
    connection.send(message);
    return (await response).value as Json;
  } finally { connection.close(); }
}

export async function checkNiri(path: string, request = niriRequest): Promise<void> {
  const { Version } = await request(path, "Version");
  const version = typeof Version === "string" ? /^(?:niri )?(\d+)\.(\d+)/u.exec(Version) : null;
  if (!version || Number(version[1]) < 25 || Number(version[1]) === 25 && Number(version[2]) < 11) throw new Error("Focused window capture needs Niri 25.11 or newer.");
}

export async function takeNiri(path: string, imagePath: string, request = niriRequest, events = new NiriConnection(path)): Promise<NiriWindow | undefined> {
  try {
    const ready = events.wait((value) => value.WindowsChanged !== undefined ? true : undefined);
    events.send("EventStream");
    await ready;
    const { FocusedWindow } = await request(path, "FocusedWindow");
    if (FocusedWindow === null) throw new Error("Niri has no focused window.");
    const window = niriWindow(FocusedWindow);
    const captured = events.wait((value) => (value.ScreenshotCaptured as { path?: unknown } | undefined)?.path === imagePath ? true : undefined);
    void captured.catch(() => undefined);
    // Explicit ID avoids capturing a different window if focus changes between requests.
    await request(path, { Action: { ScreenshotWindow: { id: window.id, write_to_disk: true, show_pointer: false, path: imagePath } } });
    await captured;
    const { Windows } = await request(path, "Windows");
    if (!Array.isArray(Windows)) throw new Error("Niri returned no window list.");
    const after = Windows.map(niriWindow).find((w) => w.id === window.id);
    return after && after.pid === window.pid && after.title === window.title && after.app_id === window.app_id &&
      after.layout.window_size.every((size, i) => size === window.layout.window_size[i]) ? window : undefined;
  } finally { events.close(); }
}
