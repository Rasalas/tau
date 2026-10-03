import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { Server as TlsServer, type TLSSocket } from "node:tls";
import { WebSocketServer, type WebSocket } from "ws";
import {
  HOST_CAPABILITY,
  HOST_CLOSE_CODE,
  HOST_ERROR,
  HOST_TRANSPORT_MAX_FRAME_BYTES,
  decodeHostClientFrame,
  decodeHostSubscription,
  hostErrorInfo,
  type HostClientCall,
  type HostIdentity,
  type HostPush,
  type HostPushEvent,
  type HostServerFrame,
} from "../shared/host-transport.js";
import { ACCESS_CLOSE_REASON, type DeviceAccess, type PairingEndpoint } from "../shared/connections.js";
import type { HostPairReply, HostPairRequest } from "../shared/pairing.js";
import { helloReply, type HostPushLog } from "./host-push-log.js";
import { HostPushFilter, hostPushScope } from "./host-push-scope.js";
import { invokeHostMethod, type HostMethodTable } from "./host-methods.js";
import { hostTokenMatches } from "./host-token.js";
import { publicKeyPin } from "./host-tls.js";
import type { AccessPeer, HostCredential, PairingChannel } from "./host-access.js";
import { isHostOwner, type AuditedCall, type HostInvocationPrincipal } from "./host-invocation.js";
import { assertListenAllowed, parseListen } from "./host-listen.js";
import { isLocalPeer, peerAddress, proxyUser, socketCapabilities, type ListenerTrust } from "./host-local-files.js";
import { forwardedHost, originAllowed } from "./host-origin.js";
import type { ClientPeer } from "./client-calls.js";
import type { HostClientSink } from "./host-transport-clients.js";
import type { HostLogger } from "./host-log.js";

const UNAUTHORIZED = HOST_CLOSE_CODE.unauthorized;
/** A socket that has not said hello by then is closed. */
export const SOCKET_HELLO_TIMEOUT_MS = 10_000;
/**
 * How often the host pings every socket at the WebSocket level. A peer that
 * has not answered the previous ping by the next one is gone (a phone that
 * slept or changed networks) and is dropped, so it stops counting as a client.
 */
export const SOCKET_PING_INTERVAL_MS = 30_000;

/** What the transport asks of the host's access model; `HostAccess` implements it. */
export interface SocketAccess {
  authenticate(token: string | undefined): HostCredential | undefined;
  /** Answers the connection's id; `close` ends it when its access is revoked or rotated away. */
  attach(credential: HostCredential, peer: AccessPeer, close: (reason: string) => void): string;
  touch(connectionId: string): void;
  detach(connectionId: string): void;
  /** What a paired device may do right now; asked on every request, so a new preset applies at once. */
  accessOf?(connectionId: string): DeviceAccess;
  /** Records a change a paired device made, or was refused. */
  audit?(connectionId: string, call: AuditedCall, allowed: boolean): void;
  /** Pairing over the socket (ADR 0024); without these a `pair` frame is refused. */
  requestPairing?(request: HostPairRequest, peer: AccessPeer, channel: PairingChannel): { id?: string; reply: HostPairReply };
  revealPairing?(id: string, nonce: string): Promise<HostPairReply>;
  withdrawPairing?(id: string): void;
}

/** A pairing request ends with the socket unless the device was let in. */
const PAIRING_DONE = 1000;

/** One secret and nothing else: the shape of a host before per-client tokens. */
function tokenOnlyAccess(token: string): SocketAccess {
  let counter = 0;
  return {
    authenticate: (offered) => (hostTokenMatches(token, offered) ? { kind: "owner" } : undefined),
    attach: () => `socket-${++counter}`,
    touch: () => undefined,
    detach: () => undefined,
  };
}

export interface SocketHostTransportOptions {
  /** `host:port` as `TAU_HOST_LISTEN` gives it; port 0 picks a free one. */
  listen: string;
  /** Reserved /resources/ capabilities, on every attached HTTP listener. */
  browserResources?: Pick<import("./host-browser-resources.js").HostBrowserResourceStore, "serve" | "detach">;
  methods: HostMethodTable;
  pushLog: HostPushLog;
  hostVersion: string;
  capabilities: string[];
  /** Named in every hello reply, so a saved machine is recognised whatever address reached it. */
  host?: { id: string; name: string; endpoints?(): readonly PairingEndpoint[] };
  /** The secret from `~/.tau/host-token`; every client repeats it in its hello. Ignored when `access` is given. */
  token?: string;
  /** The host token and the paired clients' tokens (ADR 0023). */
  access?: SocketAccess;
  /** `TAU_HOST_INSECURE=1`: bind a public interface although nothing is encrypted. */
  allowNonLoopback?: boolean;
  /** Speak TLS with this certificate; any interface may then be bound. */
  tls?: { cert: string; key: string };
  /**
   * An HTTP server to upgrade on instead of a socket of its own. A host that
   * also serves the web client gives its one here, so the browser reaches the
   * page and the protocol at the same origin and the same port. With `tls` it
   * must be an HTTPS server built from the same certificate.
   */
  attachTo?: Server;
  /** What the listener `listen` names may conclude about its peers; `loopback` by default. */
  trust?: ListenerTrust;
  /** Where attached clients are reported; without one the host counts nobody. */
  clients?: HostClientSink;
  /** Told about every authenticated connection, so a call into a window can pick one; `ClientCalls` implements it. */
  calls?: { attach(connection: string, peer: ClientPeer): void; detach(connection: string): void };
  /** Runs before every reply, so pushes still waiting to be coalesced reach the client first. */
  beforeReply?(): void;
  /** A client starts from a snapshot, not a replay: its first hello, or a resync. */
  onSnapshotClient?(): void;
  /** A connection's subscription gained these threads; what it never saw must travel whole again. */
  onThreadsSubscribed?(sessionIds: readonly string[]): void;
  /** Relays machine kit topics to this connection alone. */
  onTopicsSubscribed?(connection: string, topics: readonly string[], emit: (event: HostPushEvent) => void): void;
  onClientDetached?(connection: string): void;
  /** Page origins accepted besides the listener's own and Electron's local `file://` (`hostAllowedOrigins`); a function is asked per socket. */
  allowedOrigins?: readonly string[] | (() => readonly string[]);
  /** Defaults to `SOCKET_HELLO_TIMEOUT_MS`. */
  helloTimeoutMs?: number;
  /** Runs `tick` every `SOCKET_PING_INTERVAL_MS` by default; answers a stop. Tests tick by hand. */
  schedulePings?(tick: () => void): () => void;
  logger?: HostLogger;
}

/**
 * Compression for every frame. With context takeover (the `ws` default) the
 * window spans frames, so the small ones compress too and no threshold applies.
 */
export const SOCKET_PER_MESSAGE_DEFLATE = true;

export interface SocketHostTransport {
  readonly port: number;
  /** `wss:` or `ws:`, whichever this listener speaks. */
  readonly scheme: "wss" | "ws";
  /** Set when the listener runs without TLS beyond loopback; the caller prints it. */
  readonly warning?: string;
  /** The server `listen` bound; a certificate reload swaps its secure context. */
  readonly server: Server;
  /**
   * Serves the protocol on another server too, whose connections are judged
   * by `trust`. Detaching closes every connection that came through it.
   */
  attach(server: Server, trust: ListenerTrust): () => void;
  deliver(push: HostPush): void;
  /** Sends a call to that connection alone; false when it is gone. */
  sendCall(connection: string, call: HostClientCall): boolean;
  close(): Promise<void>;
}

/** Handled by the transport itself: replaces the connection's subscription. */
export const SUBSCRIBE_METHOD = "subscribe";

interface Session {
  connection: string;
  principal: HostInvocationPrincipal;
  /** Unset: every push goes to this connection. */
  filter?: HostPushFilter;
  /** The newest push sent to it, or the one its hello reply named as the last. */
  lastSent: number;
}

/**
 * The same method table over a local socket. Nothing runs before the hello is
 * accepted, so an unauthenticated peer can neither call a method nor observe
 * a push. Without `tls` confidentiality is a tunnel's job (ADR 0010) and a
 * public interface is refused unless the operator insists; with it, the
 * listener is an HTTPS server and the token never travels in clear text.
 */
export async function startSocketHostTransport(options: SocketHostTransportOptions): Promise<SocketHostTransport> {
  const bind = parseListen(options.listen);
  const { warning } = assertListenAllowed(bind, { encrypted: options.tls !== undefined, insecure: options.allowNonLoopback === true });
  if (warning) options.logger?.warn("host-transport-socket.insecure", { host: bind.host });
  if (options.tls && options.attachTo && !(options.attachTo instanceof TlsServer)) {
    throw new Error("A TLS listener cannot attach to a plain HTTP server; build the web client's server with the same certificate.");
  }
  const { host, port } = bind;
  const http = options.attachTo ?? (options.tls ? createTlsUpgradeServer(options.tls) : createUpgradeServer());
  // No server of its own: every listener hands its upgrades over with the trust it has.
  const server = new WebSocketServer({ noServer: true, maxPayload: HOST_TRANSPORT_MAX_FRAME_BYTES, perMessageDeflate: SOCKET_PER_MESSAGE_DEFLATE });
  if (!options.access && !options.token) throw new Error("A socket listener needs a host token or an access model.");
  const access = options.access ?? tokenOnlyAccess(options.token!);
  /** Every authenticated socket, with the principal its requests run as. */
  const authenticated = new Map<WebSocket, Session>();
  /** Sockets that asked to pair and have not been answered for good. */
  const pairing = new Map<WebSocket, { frameId: string; requestId?: string }>();
  /** The id the client registry knows a socket by, while it is authenticated. */
  const clientIds = new Map<WebSocket, string>();
  const sockets = new Map<string, WebSocket>();
  /** The listener each socket came through, so detaching one closes its sockets. */
  const origins = new Map<WebSocket, Server>();
  const forget = (socket: WebSocket): void => {
    const asked = pairing.get(socket);
    pairing.delete(socket);
    if (asked?.requestId) access.withdrawPairing?.(asked.requestId);
    const session = authenticated.get(socket);
    authenticated.delete(socket);
    if (session) {
      options.browserResources?.detach(session.connection);
      options.onClientDetached?.(session.connection);
      sockets.delete(session.connection);
      access.detach(session.connection);
      options.calls?.detach(session.connection);
    }
    const clientId = clientIds.get(socket);
    if (clientId === undefined) return;
    clientIds.delete(socket);
    options.clients?.detached(clientId);
  };

  const send = (socket: WebSocket, frame: HostServerFrame): void => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
  };
  /** A paired device's access as it stands now: a new preset applies to its next request and push. */
  const readOnlySession = (session: { connection: string; principal: HostInvocationPrincipal }): boolean =>
    session.principal.kind === "workbench-client" && session.principal.pairedClient !== undefined && (access.accessOf?.(session.connection) ?? "read-only") === "read-only";
  /** A paired device's requests carry what it may do now and a way to record what it changed. */
  const principalFor = (session: { connection: string; principal: HostInvocationPrincipal }): HostInvocationPrincipal => {
    if (session.principal.kind !== "workbench-client" || session.principal.pairedClient === undefined) return session.principal;
    const readOnly = readOnlySession(session);
    return Object.freeze({
      ...session.principal,
      ...(readOnly ? { readOnly: true as const } : {}),
      ...(access.audit ? { audit: (call: AuditedCall, allowed: boolean) => access.audit!(session.connection, call, allowed) } : {}),
    });
  };

  const pairReply = (socket: WebSocket, id: string, reply: HostPairReply): boolean => {
    if (socket.readyState !== socket.OPEN) return false;
    send(socket, { type: "pair-reply", id, reply });
    if (reply.state === "approved") {
      setTimeout(() => {
        if (!authenticated.has(socket)) socket.close(HOST_CLOSE_CODE.helloTimeout, "no hello");
      }, options.helloTimeoutMs ?? SOCKET_HELLO_TIMEOUT_MS).unref?.();
    // The close withdraws whatever the socket still had open.
    } else if (reply.state !== "challenge" && reply.state !== "waiting") socket.close(PAIRING_DONE, reply.state);
    return true;
  };

  /** A device that holds no token yet asks to be let in; the owner decides on the host (ADR 0024). */
  const handlePairing = (socket: WebSocket, frame: { type: "pair"; id: string; pair: HostPairRequest } | { type: "pair-reveal"; id: string; nonce: string }, peer: AccessPeer, own: ListenerIdentity | undefined): void => {
    const asked = pairing.get(socket);
    const invalid = () => pairReply(socket, frame.id, { state: "refused", reason: "invalid" });
    if (!access.requestPairing || !access.revealPairing || authenticated.has(socket)) { invalid(); return; }
    if (frame.type === "pair") {
      if (asked) { invalid(); return; }
      const state: { frameId: string; requestId?: string } = { frameId: frame.id };
      pairing.set(socket, state);
      const { id, reply } = access.requestPairing(frame.pair, peer, {
        ...(own ? { fingerprint: own.fingerprint, publicKey: own.publicKey } : {}),
        settle: (outcome) => pairReply(socket, frame.id, outcome),
      });
      if (id) state.requestId = id;
      pairReply(socket, frame.id, reply);
      return;
    }
    if (!asked?.requestId || asked.frameId !== frame.id) { invalid(); return; }
    void access.revealPairing(asked.requestId, frame.nonce).then((reply) => { pairReply(socket, frame.id, reply); });
  };

  /** A response goes after every push its method caused, even one still being coalesced. */
  const respond = (socket: WebSocket, response: HostServerFrame): void => {
    options.beforeReply?.();
    send(socket, response);
  };

  const followTopics = (socket: WebSocket, session: Session, topics: readonly string[]): void => {
    options.onTopicsSubscribed?.(session.connection, topics, (event) => {
      if (authenticated.get(socket) !== session || socket.readyState !== socket.OPEN) return;
      const push = options.pushLog.record(event, { replay: false });
      send(socket, { type: "push", push: { ...push, ...(session.lastSent === push.seq - 1 ? {} : { prev: session.lastSent }) } });
      session.lastSent = push.seq;
    });
  };

  /**
   * Answered at once, without flushing waiting pushes first: every push before
   * the response went out under the old subscription, every push after it
   * under the new one, so a client that loses the link knows which it has.
   */
  const subscribe = (socket: WebSocket, session: Session, id: string, value: unknown): void => {
    if (value === null || value === undefined) {
      delete session.filter;
      send(socket, { type: "response", response: { id, result: true } });
      followTopics(socket, session, []);
      return;
    }
    const subscription = decodeHostSubscription(value);
    if (!subscription) {
      send(socket, { type: "response", response: { id, error: { message: "subscribe expects { threads, topics } or null.", code: HOST_ERROR.invalidRequest } } });
      return;
    }
    const filter = new HostPushFilter(subscription, session.filter);
    const added = filter.addedThreads(session.filter);
    session.filter = filter;
    if (added.length > 0) options.onThreadsSubscribed?.(added);
    send(socket, { type: "response", response: { id, result: true } });
    followTopics(socket, session, subscription.topics);
  };

  /** Sockets that answered the last WebSocket ping, or sent anything since. */
  const alive = new WeakSet<WebSocket>();

  const accept = (socket: WebSocket, request: IncomingMessage, trust: ListenerTrust): void => {
    const origin = request.headers.origin;
    const allowed = typeof options.allowedOrigins === "function" ? options.allowedOrigins() : options.allowedOrigins;
    if (!originAllowed({
      origin,
      host: request.headers.host,
      // `file://` is a window on this machine only where the listener can tell.
      ...(trust === "loopback" && request.socket.remoteAddress ? { peerAddress: request.socket.remoteAddress } : {}),
      // Behind a proxy the page's host is the one the proxy was reached at.
      ...(trust === "proxy" ? { forwardedHost: forwardedHost(request.headers["x-forwarded-host"]) } : {}),
    }, allowed)) {
      options.logger?.warn("host-transport-socket.origin-refused", { origin });
      socket.close(HOST_CLOSE_CODE.forbiddenOrigin, "origin not allowed");
      return;
    }
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
    // Bytes of a frame still arriving count too: an 11 MB file piece over a slow link takes longer than a ping round.
    request.socket.on("data", () => alive.add(socket));
    // A device waiting for its owner has until its request expires; once let in, a new deadline for its hello.
    const helloTimer = setTimeout(() => {
      if (!authenticated.has(socket) && !pairing.has(socket)) socket.close(HOST_CLOSE_CODE.helloTimeout, "no hello");
    }, options.helloTimeoutMs ?? SOCKET_HELLO_TIMEOUT_MS);
    helloTimer.unref?.();
    // Only a peer on this machine may be told that the host's files are local.
    const capabilities = [
      ...socketCapabilities(options.capabilities, request.socket.remoteAddress, process.env, trust),
      HOST_CAPABILITY.heartbeat,
      HOST_CAPABILITY.subscriptions,
    ];
    const local = isLocalPeer(trust, request.socket.remoteAddress);
    const address = peerAddress(trust, request);
    const viaProxy = proxyUser(trust, request);
    socket.on("message", (data) => {
      alive.add(socket);
      let payload: unknown;
      try { payload = JSON.parse(String(data)) as unknown; } catch { payload = undefined; }
      const frame = decodeHostClientFrame(payload);
      if (!frame) {
        options.logger?.warn("host-transport-socket.malformed-frame");
        // Not 4401: a client forgets its token on that, and a proxy or a bad link can garble a frame.
        socket.close(HOST_CLOSE_CODE.protocolError, "malformed frame");
        return;
      }
      if (frame.type === "pair" || frame.type === "pair-reveal") {
        const userAgent = request.headers["user-agent"];
        handlePairing(socket, frame, {
          ...(address ? { address } : {}),
          ...(typeof userAgent === "string" ? { userAgent } : {}),
          trust,
        }, ownCertificate(request));
        return;
      }
      if (frame.type === "hello") {
        const credential = access.authenticate(frame.hello.token);
        if (!credential) {
          options.logger?.warn("host-transport-socket.unauthorized");
          socket.close(UNAUTHORIZED, ACCESS_CLOSE_REASON.unauthorized);
          return;
        }
        // A client that says hello twice on one socket replaces itself, with
        // whatever profile it now claims.
        forget(socket);
        // Waiting pushes are numbered now, before the reply names the next sequence.
        options.beforeReply?.();
        const userAgent = request.headers["user-agent"];
        const connection = access.attach(credential, {
          ...(address ? { address } : {}),
          ...(viaProxy ? { proxyUser: viaProxy } : {}),
          ...(typeof userAgent === "string" ? { userAgent } : {}),
          ...(frame.hello.profile ? { profile: frame.hello.profile } : {}),
          ...(frame.hello.auxiliary ? { auxiliary: true } : {}),
        }, (reason) => {
          // Gone from the set first, so nothing more is delivered on the way out.
          forget(socket);
          socket.close(UNAUTHORIZED, reason);
        });
        clearTimeout(helloTimer);
        sockets.set(connection, socket);
        // Only a window's own process runs halves; a renderer names the window it sits in.
        options.calls?.attach(connection, {
          local,
          ...(credential.kind === "client" ? { pairedClient: credential.clientId } : {}),
          ...(frame.hello.windowId ? { windowId: frame.hello.windowId } : {}),
          ...(frame.hello.auxiliary && frame.hello.windowHalves ? { windowHalves: frame.hello.windowHalves } : {}),
        });
        const filter = frame.hello.subscription ? new HostPushFilter(frame.hello.subscription) : undefined;
        const session: Session = {
          connection,
          principal: Object.freeze({
            kind: "workbench-client",
            connection,
            ...(credential.kind === "client" ? { pairedClient: credential.clientId } : {}),
            // Only a connection from this machine through the loopback listener may manage access (ADR 0024).
            ...(local ? { local: true as const } : {}),
          }),
          ...(filter ? { filter } : {}),
          lastSent: options.pushLog.nextSeq - 1,
        };
        authenticated.set(socket, session);
        // The reply first: it carries the sequence this client starts from, and
        // the push that announces its own arrival must come after that number.
        const identity = options.host ? helloIdentity(options.host) : undefined;
        const readOnly = readOnlySession(session);
        const reply = helloReply(options.pushLog, frame.hello, { hostVersion: options.hostVersion, capabilities, ...(identity ? { host: identity } : {}) }, filter, readOnly);
        // Legacy unfiltered clients advance only through replayed events, not over client-only relays.
        if (!filter && frame.hello.lastSeq !== undefined && !reply.resync) session.lastSent = reply.missed.at(-1)?.seq ?? frame.hello.lastSeq;
        // Said here so a client that manages nothing never asks for the list it would be refused.
        const owner = isHostOwner(session.principal);
        send(socket, { type: "hello-reply", id: frame.id, reply: { ...reply, ...(readOnly ? { access: "read-only" as const } : {}), owner } });
        followTopics(socket, session, frame.hello.subscription?.topics ?? []);
        if (!frame.hello.auxiliary && (frame.hello.lastSeq === undefined || reply.resync)) options.onSnapshotClient?.();
        if (options.clients && !frame.hello.auxiliary) {
          clientIds.set(socket, options.clients.attached({
            transport: "socket",
            ...(frame.hello.profile ? { profile: frame.hello.profile } : {}),
          }));
        }
        return;
      }
      const session = authenticated.get(socket);
      if (!session) {
        socket.close(HOST_CLOSE_CODE.protocolError, "hello first");
        return;
      }
      // Not activity of the user's: a heartbeat leaves "last seen" alone.
      if (frame.type === "ping") {
        send(socket, { type: "pong", id: frame.id });
        return;
      }
      const { id, method, params } = frame.request;
      if (method === SUBSCRIBE_METHOD) {
        subscribe(socket, session, id, params[0]);
        return;
      }
      access.touch(session.connection);
      // JSON turns a missing positional argument into null; decoders expect undefined.
      const normalized = params.map((value) => (value === null ? undefined : value));
      void invokeHostMethod(options.methods, method, normalized, principalFor(session))
        .then((result) => respond(socket, { type: "response", response: { id, result } }))
        .catch((error: unknown) => {
          const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : HOST_ERROR.failed;
          respond(socket, { type: "response", response: { id, error: hostErrorInfo(error, code) } });
        });
    });
    socket.on("close", () => { clearTimeout(helloTimer); origins.delete(socket); forget(socket); });
    socket.on("error", () => { clearTimeout(helloTimer); forget(socket); });
  };

  const attach = (target: Server, trust: ListenerTrust): (() => void) => {
    // One HTTP dispatcher, rather than competing listeners that can both write a response.
    const previous = options.browserResources ? target.rawListeners("request") : [];
    const dispatch = (request: IncomingMessage, response: ServerResponse): void => {
      if (request.url?.startsWith("/resources/")) { void options.browserResources!.serve(request, response); return; }
      for (const listener of previous) listener.call(target, request, response);
    };
    if (options.browserResources) { target.removeAllListeners("request"); target.on("request", dispatch); }
    const onUpgrade = (request: IncomingMessage, stream: Parameters<WebSocketServer["handleUpgrade"]>[1], head: Buffer): void => {
      server.handleUpgrade(request, stream, head, (socket) => {
        origins.set(socket, target);
        accept(socket, request, trust);
      });
    };
    target.on("upgrade", onUpgrade);
    return () => {
      target.off("upgrade", onUpgrade);
      if (options.browserResources) { target.off("request", dispatch); for (const listener of previous) target.on("request", listener as (request: IncomingMessage, response: ServerResponse) => void); }
      for (const [socket, origin] of [...origins]) {
        if (origin !== target) continue;
        origins.delete(socket);
        forget(socket);
        socket.close();
      }
    };
  };
  attach(http, options.trust ?? "loopback");

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => { http.off("error", reject); resolve(); });
  });
  const pingAll = (): void => {
    for (const socket of server.clients) {
      if (!alive.has(socket)) { socket.terminate(); continue; }
      alive.delete(socket);
      socket.ping();
    }
  };
  const stopPings = options.schedulePings?.(pingAll) ?? everyInterval(pingAll, SOCKET_PING_INTERVAL_MS);
  const address = http.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  const scheme = options.tls ? "wss" : "ws";
  options.logger?.info("host-transport-socket.listening", { host, port: boundPort, scheme });

  return {
    port: boundPort,
    scheme,
    server: http,
    attach,
    ...(warning ? { warning } : {}),
    deliver: (push) => {
      if (authenticated.size === 0) return;
      const scope = hostPushScope(push.event);
      let event: string | undefined;
      let frame: string | undefined;
      for (const [socket, session] of authenticated) {
        if (socket.readyState !== socket.OPEN || !(session.filter?.admits(push.event, scope) ?? true)) continue;
        if (scope === "writers" && readOnlySession(session)) continue;
        event ??= JSON.stringify(push.event);
        // The first push after skipped ones says so, or the client would count a gap.
        const prev = session.lastSent === push.seq - 1 ? "" : `,"prev":${session.lastSent}`;
        const text = prev
          ? `{"type":"push","push":{"seq":${push.seq}${prev},"event":${event}}}`
          : (frame ??= `{"type":"push","push":{"seq":${push.seq},"event":${event}}}`);
        socket.send(text);
        session.lastSent = push.seq;
      }
    },
    sendCall: (connection, call) => {
      const socket = sockets.get(connection);
      if (!socket || socket.readyState !== socket.OPEN) return false;
      socket.send(JSON.stringify({ type: "client-call", call } satisfies HostServerFrame));
      return true;
    },
    close: async () => {
      stopPings();
      // One that never said hello would otherwise hold the port open.
      for (const socket of server.clients) if (!authenticated.has(socket)) socket.terminate();
      for (const socket of [...authenticated.keys()]) { forget(socket); socket.close(); }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function helloIdentity(host: NonNullable<SocketHostTransportOptions["host"]>): HostIdentity {
  const endpoints = host.endpoints?.() ?? [];
  return { id: host.id, name: host.name, ...(endpoints.length ? { endpoints: [...endpoints] } : {}) };
}

function everyInterval(tick: () => void, ms: number): () => void {
  const timer = setInterval(tick, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}

const upgradeOnly = (_request: IncomingMessage, response: ServerResponse): void => {
  response.writeHead(426, { "content-type": "text/plain; charset=utf-8", connection: "close" });
  response.end("This port speaks the Tau host protocol over WebSocket.");
};

interface ListenerIdentity {
  fingerprint: string;
  publicKey: string;
}

/**
 * The certificate and key this socket's listener presented, as a pinning
 * device saw them; the pairing digits are bound to one of them. Absent on
 * plaintext, and behind a proxy that ends TLS itself.
 */
function ownCertificate(request: IncomingMessage): ListenerIdentity | undefined {
  const socket = request.socket as Partial<TLSSocket>;
  const certificate = typeof socket.getX509Certificate === "function" ? socket.getX509Certificate() : undefined;
  return certificate ? { fingerprint: certificate.fingerprint256, publicKey: publicKeyPin(certificate) } : undefined;
}

/** An HTTPS server with nothing to serve but the upgrade to the protocol. */
function createTlsUpgradeServer(tls: { cert: string; key: string }): Server {
  return createHttpsServer({ cert: tls.cert, key: tls.key, minVersion: "TLSv1.2" }, upgradeOnly);
}

function createUpgradeServer(): Server {
  return createHttpServer(upgradeOnly);
}

/** A server for another listener with nothing but the protocol on it; `attach` it to a transport. */
export function createProtocolServer(tls?: { cert: string; key: string }): Server {
  return tls ? createTlsUpgradeServer(tls) : createUpgradeServer();
}
