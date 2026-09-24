/** What the native side reports about one socket. */
export type NativeSocketEvent =
  | { id: string; type: "open"; fingerprint?: string; publicKey?: string }
  | { id: string; type: "message"; data: string }
  /** `pinMismatch`: the host presented a certificate other than the pinned one. */
  | { id: string; type: "close"; code: number; reason?: string; pinMismatch?: boolean };

export interface NativeSocketRequest {
  id: string;
  url: string;
  /** SHA-256 of the public key (SPKI) to accept, `AB:CD:…`; decides alone when given. */
  publicKey?: string;
  /** SHA-256 of the one certificate to accept: an old pin, only without `publicKey`. Without either the platform's trust decides. */
  fingerprint?: string;
  /** Accept a certificate the platform trusts for this name when it is not the pinned one: old pins only. */
  allowAuthority?: boolean;
  headers?: Record<string, string>;
}

/** The plugin's socket methods and its one event stream, per socket id. */
export interface SocketBridge {
  open(request: NativeSocketRequest): Promise<void>;
  send(id: string, data: string): Promise<void>;
  close(id: string, code?: number, reason?: string): Promise<void>;
  subscribe(id: string, listener: (event: NativeSocketEvent) => void): () => void;
}

export interface NativeSocketOptions {
  publicKey?: string;
  fingerprint?: string;
  allowAuthority?: boolean;
  headers?: Record<string, string>;
}

type Listener = (event: { data?: unknown; code?: number; reason?: string }) => void;

let counter = 0;

/**
 * A socket opened by the app's native side, shaped like a browser `WebSocket`
 * so the host transport and pairing can use it unchanged. The web view cannot
 * pin a self-signed certificate; URLSession and OkHttp can.
 */
export class NativeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = NativeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  /** SHA-256 of the certificate the host presented, once open over TLS. */
  fingerprint: string | undefined;
  /** SHA-256 of its public key, once open over TLS. */
  publicKey: string | undefined;
  /** The socket closed because the certificate was not the pinned one. */
  pinMismatch = false;

  private readonly id = `s${(counter += 1)}-${Math.random().toString(36).slice(2, 8)}`;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly unsubscribe: () => void;

  constructor(private readonly bridge: SocketBridge, readonly url: string, options: NativeSocketOptions = {}) {
    this.unsubscribe = bridge.subscribe(this.id, (event) => this.handle(event));
    bridge.open({
      id: this.id,
      url,
      ...(options.publicKey ? { publicKey: options.publicKey } : {}),
      ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
      ...(options.allowAuthority ? { allowAuthority: true } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    }).catch((error: unknown) => this.handle({ id: this.id, type: "close", code: 1006, reason: error instanceof Error ? error.message : String(error) }));
  }

  addEventListener(type: "open" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code?: number; reason?: string }) => void): void;
  addEventListener(type: string, listener: (event: never) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, set = new Set());
    set.add(listener as Listener);
  }

  send(data: string): void {
    if (this.readyState !== NativeSocket.OPEN) throw new Error("The socket is not open.");
    void this.bridge.send(this.id, data).catch(() => undefined);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= NativeSocket.CLOSING) return;
    this.readyState = NativeSocket.CLOSING;
    // A socket the native side no longer knows closes here and now.
    this.bridge.close(this.id, code, reason).catch(() => this.handle({ id: this.id, type: "close", code: code ?? 1000, ...(reason ? { reason } : {}) }));
  }

  private handle(event: NativeSocketEvent): void {
    switch (event.type) {
      case "open":
        if (this.readyState !== NativeSocket.CONNECTING) return;
        this.readyState = NativeSocket.OPEN;
        this.fingerprint = event.fingerprint;
        this.publicKey = event.publicKey;
        this.onopen?.();
        this.emit("open", {});
        return;
      case "message":
        if (this.readyState !== NativeSocket.OPEN) return;
        this.onmessage?.({ data: event.data });
        this.emit("message", { data: event.data });
        return;
      case "close": {
        if (this.readyState === NativeSocket.CLOSED) return;
        const opened = this.readyState !== NativeSocket.CONNECTING;
        this.readyState = NativeSocket.CLOSED;
        this.pinMismatch = event.pinMismatch === true;
        this.unsubscribe();
        const detail = { code: event.code, ...(event.reason ? { reason: event.reason } : {}) };
        if (!opened) {
          this.onerror?.();
          this.emit("error", {});
        }
        this.onclose?.(detail);
        this.emit("close", detail);
      }
    }
  }

  private emit(type: string, event: Parameters<Listener>[0]): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
