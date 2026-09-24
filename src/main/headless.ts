import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { Server as TlsServer } from "node:tls";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { HostEvent } from "../shared/contracts.js";
import { HOST_CAPABILITY, HOST_ERROR, type HostPushEvent } from "../shared/host-transport.js";
import { pairingUrl } from "../shared/connections.js";
import { WorkspaceIdentity, readOrCreateHostId } from "./workspace-identity.js";
import { EXTENSION_API_VERSION, type ExtensionHostVersions } from "../shared/extension-compat.js";
import { HostLog } from "./host-log.js";
import { HostJobRunner } from "./host-jobs.js";
import { HostPushLog } from "./host-push-log.js";
import { HostPushCoalescer } from "./host-push-coalescer.js";
import { createHostMethods } from "./host-methods.js";
import { HostTokenFile, hostTokenPath } from "./host-token.js";
import { HostAccess } from "./host-access.js";
import { promptPairingsOnTerminal } from "./host-pairing-terminal.js";
import { endpointOrigins, type HostConnectionsService, type HostListenInfo } from "./host-connections.js";
import { isHostOwner } from "./host-invocation.js";
import { HostClientRegistry } from "./host-clients.js";
import { hostAllowedOrigins } from "./host-origin.js";
import { createProtocolServer, startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
import { createWebClientServer } from "./host-web-server.js";
import { isLoopbackHost, parseListen } from "./host-listen.js";
import { HostTlsReloader, resolveHostTls } from "./host-tls.js";
import { HostNetworkAccess } from "./host-network.js";
import { NO_BUNDLED_KITS, inspectBundledKits, loadBundledKitDesktopHalves, shippedHostExtensions } from "./bundled-kits.js";
import { loadHostExtensionPackages, inspectExtensionPackages } from "./extension-packages.js";
import { loadDesktopExtensions } from "./desktop-extensions.js";
import { installShellEnvironment } from "./shell-environment.js";
import { PiHost } from "./pi-host.js";
import { HostStart } from "./host-start.js";
import { ClientCalls } from "./client-calls.js";
import { selectDefaultBackend } from "./runtime-adapters.js";
import { primeOpenCodeCatalog } from "./pi-model-runtime.js";
import { ProjectHistory } from "./project-history.js";
import { IdleHeapCompactor } from "./host-idle-compaction.js";

/**
 * The host without a window: the same `PiHost` and the same method table,
 * reachable only over the socket transport. This is what a remote client
 * connects to, and what `scripts/remote-host-smoke.mjs` drives.
 */
const workspace = process.env.TAU_WORKSPACE || process.cwd();
const safeMode = process.env.TAU_NO_EXTENSIONS === "1";
const userData = process.env.TAU_USER_DATA || join(homedir(), ".tau", "headless");
const listen = process.env.TAU_HOST_LISTEN || "127.0.0.1:0";
// A loopback listener for a reverse proxy on this machine; every peer on it counts as remote.
const proxyListen = process.env.TAU_HOST_PROXY_LISTEN;
/** How often network access looks again at Tailscale's addresses and the certificate files. */
const NETWORK_POLL_MS = 60_000;
// A supervised host is told which version it belongs to; a hand-started one
// reads npm's environment, as it always did.
const hostVersion = process.env.TAU_HOST_VERSION || process.env.npm_package_version || "0.0.0";
// dist-electron/main/headless.js -> the app root the kits are shipped in.
const appRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// The built browser client, when there is one; `npm run build:web` writes it.
const webRoot = process.env.TAU_WEB_CLIENT || join(appRoot, "dist-web");

// Its own file: the window process writes host.log in the same directory.
const hostLog = new HostLog({ dir: join(userData, "logs"), fileName: "host-process.log" });
const hostId = readOrCreateHostId(join(userData, "host-id"));
const workspaceIdentity = new WorkspaceIdentity(hostId);
const pushLog = new HostPushLog();
const compactor = new IdleHeapCompactor({
  onCompacted: ({ beforeBytes, afterBytes, ms }) =>
    hostLog.info("host.heap.compacted", `${Math.round(beforeBytes / 1048576)} → ${Math.round(afterBytes / 1048576)} MiB in ${Math.round(ms)} ms`),
});
/** Streamed text and tool output are merged here before they are numbered. */
const pushes = new HostPushCoalescer((event) => {
  compactor.noteActivity();
  const push = pushLog.record(event);
  socket?.deliver(push);
  return push.seq;
});
const jobs = new HostJobRunner((event) => broadcast(event));
/** The other direction: what a host extension asks one client's process to do. */
const clientCalls = new ClientCalls((connection, call) => socket?.sendCall(connection, call) ?? false);
let socket: SocketHostTransport | undefined;
let networkPoll: ReturnType<typeof setInterval> | undefined;

function broadcast(event: HostPushEvent): void {
  pushes.publish(event);
}

function publish(event: HostEvent): void {
  if (event.type === "event-log") hostLog.info(event.label, event.detail);
  broadcast(event);
}

const versions: ExtensionHostVersions = { tau: hostVersion, pi: PI_VERSION, api: EXTENSION_API_VERSION };
/** Where the kits Tau ships are read from; a headless host runs from the same tree. */
const kitOptions = { appPath: appRoot, cacheDir: join(userData, "host-extensions"), versions };
const unsupported = (what: string) => () => { throw new Error(`${what} needs a desktop window.`); };

async function main(): Promise<void> {
  await installShellEnvironment().catch((error: unknown) => hostLog.warn("shell-environment.failed", error));
  const projectHistory = new ProjectHistory(join(userData, "projects.json"), undefined, hostLog, (path) => workspaceIdentity.ref(path));
  await projectHistory.load();

  /** The socket transport reports its clients here; the host publishes the count. */
  const clients = new HostClientRegistry();
  const started = new HostStart(() => {
    primeOpenCodeCatalog();
    return new PiHost(workspace, publish, projectHistory, safeMode, false, {
      defaultBackendKind: selectDefaultBackend(undefined, { safeMode }),
      hostExtensions: safeMode ? [] : shippedHostExtensions(kitOptions, (label, detail) => hostLog.warn(label, detail)),
      hostExtensionPackages: (cwd: string) => loadHostExtensionPackages(cwd, getAgentDir(), {
        versions,
        cacheDir: join(userData, "host-extensions"),
      }),
      logger: hostLog,
      workspaceIdentity,
      clients,
      appPath: appRoot,
      kitStateDir: join(userData, "kit-state"),
      turnsInFlightPath: join(userData, "turns-in-flight.json"),
      queuedMessagesPath: join(userData, "queued-messages.json"),
      threadLimitsPath: join(userData, "thread-limits.json"),
      threadTrashDir: join(userData, "thread-trash"),
      // A window half of a kit lives in the client's process; this is the
      // only way a host without a window of its own reaches one. The folder
      // picker is the window's own, and only the asking client's window shows it.
      platform: {
        callClient: (extensionId, command, input) => clientCalls.call(extensionId, command, input),
        pickDirectory: (options) => clientCalls.pickDirectory(options),
      },
      sessionUsageCachePath: join(userData, "session-usage.json"),
      sessionLineageCachePath: join(userData, "session-lineage.json"),
      runtimeCatalogsPath: join(userData, "runtime-catalogs.json"),
      warmRuntimeCatalogs: true,
    });
  });
  const tokenFile = new HostTokenFile(hostTokenPath());
  let terminalPairing: (() => void) | undefined;
  const access = await HostAccess.open({
    tokenFile,
    storePath: join(userData, "paired-clients.json"),
    logger: hostLog,
    // No details on the wire: only an owner may ask connections-list what changed.
    onChange: () => { publish({ type: "connections-changed" }); terminalPairing?.(); },
    audit: (entry) => (entry.allowed ? hostLog.info("access.action", entry) : hostLog.warn("access.refused", entry)),
  });
  // Requests nobody answered and tokens unused past their timeout end here, not only at the next hello.
  setInterval(() => access.sweep(), 60_000).unref();
  let listening: HostListenInfo | undefined;
  let network: HostNetworkAccess | undefined;
  let mainTls: HostTlsReloader | undefined;
  const reloadCertificates = async (): Promise<{ changed: boolean }> => {
    const own = mainTls?.reload() ?? false;
    const fromNetwork = network ? (await network.reloadCertificate()).changed : false;
    if (listening && mainTls) listening = { ...listening, fingerprint: mainTls.current.fingerprint };
    return { changed: own || fromNetwork };
  };
  const staticOrigins = hostAllowedOrigins();
  /** Origins of the published endpoints; the socket accepts pages opened at any of them. */
  let publishedOrigins: string[] = [];
  const connectionsService = (): HostConnectionsService => ({
    access,
    listen: () => listening,
    hostId,
    hostName: hostname(),
    ...(network ? {
      network: {
        state: () => network!.state(),
        endpoints: (names) => network!.endpoints(names),
        update: async (input) => {
          const state = await network!.update(input);
          await refreshOrigins();
          return state;
        },
      },
    } : {}),
    reloadCertificates,
  });
  const refreshOrigins = async (): Promise<void> => {
    publishedOrigins = await endpointOrigins(connectionsService()).catch((error: unknown) => {
      hostLog.warn("host-network.origins-failed", error);
      return publishedOrigins;
    });
  };
  const methods = createHostMethods({
    clientCalls,
    connections: () => connectionsService(),
    ...started.methodDeps(),
    jobs,
    platform: {
      // A headless host has no clipboard, no window and no build of its own.
      copyText: unsupported("Copying text"),
      copyImage: unsupported("Copying an image"),
      readImagePreview: async () => undefined,
      inspectExtensions: async (cwd) => {
        const [kits, inspection] = await Promise.all([
          safeMode ? NO_BUNDLED_KITS : inspectBundledKits(kitOptions),
          inspectExtensionPackages(cwd, getAgentDir(), { versions }),
        ]);
        return {
          ...inspection,
          ...(kits.distribution ? { distribution: { name: kits.distribution.name, version: kits.distribution.version } } : {}),
          packages: [...kits.packages, ...inspection.packages],
        };
      },
      loadDesktopExtensions: async (cwd, sharedExports, only) => {
        const [kits, result] = await Promise.all([
          safeMode ? { bundles: [], errors: [] } : loadBundledKitDesktopHalves({ ...kitOptions, sharedExports, ...(only ? { only } : {}) }),
          loadDesktopExtensions(cwd, getAgentDir(), { sharedExports, versions, ...(only ? { only } : {}) }),
        ]);
        return { ...result, bundles: [...kits.bundles, ...result.bundles], errors: [...kits.errors, ...result.errors] };
      },
      rebuildWorkbench: unsupported("Rebuilding the workbench"),
      workbenchSource: unsupported("Opening Tau source"),
      relaunchWorkbench: unsupported("Relaunching the workbench"),
      installUpdate: unsupported("Installing an update"),
      notify: unsupported("A system notification"),
      setBadge: unsupported("A badge on the app icon"),
    },
  });

  const shutdown = (): void => {
    void (async () => {
      clientCalls.dispose();
      compactor.dispose();
      clearInterval(networkPoll);
      await network?.close().catch((error: unknown) => hostLog.warn("host-network.close-failed", error));
      await socket?.close();
      await access.flush().catch((error: unknown) => hostLog.warn("host.access.flush-failed", error));
      await started.current()?.dispose().catch((error: unknown) => hostLog.error("host.shutdown.failed", error));
      process.exit(0);
    })();
  };
  // Not part of the client protocol: the supervisor that started this process
  // asks for a clean stop here before it reaches for a signal (ADR 0021).
  methods["host.shutdown"] = async (_params, context) => {
    if (!isHostOwner(context.principal)) throw Object.assign(new Error("Only the host token, on this machine, may stop the host."), { code: HOST_ERROR.forbidden });
    hostLog.info("host.shutdown.requested");
    // Answer first, leave afterwards.
    setTimeout(shutdown, 50).unref();
    return { stopping: true };
  };

  const { host: boundHost } = parseListen(listen);
  // TAU_HOST_TLS=1, or a certificate of the operator's own; the key stays under userData.
  // Re-read when its files change, so a renewed certificate needs no restart.
  const envTls = () => resolveHostTls(process.env, { userData, bindHost: boundHost });
  const tls = envTls();
  mainTls = tls ? new HostTlsReloader(() => envTls()!, { initial: tls }) : undefined;
  // A built client turns this host into something a browser can open. Without
  // one the host is exactly what it was: a socket and nothing else.
  const web = existsSync(join(webRoot, "index.html"))
    ? createWebClientServer({ dir: webRoot, ...(tls ? { tls } : {}) })
    : undefined;
  socket = await startSocketHostTransport({
    listen,
    methods: compactor.observe(methods),
    pushLog,
    beforeReply: () => pushes.flush(),
    onSnapshotClient: () => pushes.resendWholeOutputs(),
    onThreadsSubscribed: (sessionIds) => pushes.resendWholeOutputs(sessionIds),
    hostVersion,
    capabilities: [HOST_CAPABILITY.jobs, HOST_CAPABILITY.replay],
    access,
    allowNonLoopback: process.env.TAU_HOST_INSECURE === "1",
    allowedOrigins: () => [...staticOrigins, ...publishedOrigins],
    ...(tls ? { tls } : {}),
    ...(web ? { attachTo: web.server } : {}),
    clients,
    calls: clientCalls,
    logger: hostLog,
  });
  if (mainTls) mainTls.track(socket.server as unknown as TlsServer);
  // The smoke test reads this line to learn the port when it asked for 0.
  listening = { scheme: socket.scheme, host: boundHost, port: socket.port, webClient: web !== undefined, ...(tls ? { fingerprint: tls.fingerprint } : {}) };
  console.log(`tau-host listening on ${socket.scheme}://${boundHost}:${socket.port}`);
  console.log(`token: ${tokenFile.path} (copy it to the client machine, or pass it as TAU_HOST_TOKEN)`);
  if (tls) {
    const origin = tls.source === "self-signed" ? `self-signed, ${tls.created ? "created now" : "kept"} in ${tls.certPath}` : `from ${tls.certPath}`;
    console.log(`tls: certificate ${origin}`);
    console.log(`tls fingerprint: SHA256 ${tls.fingerprint} (a client pins it as TAU_HOST_FINGERPRINT)`);
    for (const warning of tls.warnings) console.warn(`tls warning: ${warning}`);
    hostLog.info("host.tls", { source: tls.source, fingerprint: tls.fingerprint, created: tls.created });
  }
  if (socket.warning) console.warn(`\nWARNING: ${socket.warning}\n`);
  // The code lives in the fragment: no proxy, no access log and no Referer
  // ever carries it, and the page drops it before it renders anything. It
  // only asks: the owner still allows the device (ADR 0024).
  const { code } = access.createLink();
  const page = `${tls ? "https" : "http"}://${boundHost}:${socket.port}/`;
  const link = pairingUrl(page, { code, ...(tls ? { fingerprint: tls.fingerprint } : {}), hostId, hostName: hostname() });
  console.log(`${web ? "web client" : "pairing link"}: ${link} (single use, 10 minutes; allow the device in Settings → Connections${process.stdin.isTTY ? " or here" : ""})`);
  if (!web) console.log(`web client: not built (run npm run build:web, or point TAU_WEB_CLIENT at a build)`);
  // A host started by hand in a terminal asks there; a supervised one has a window to ask in.
  if (process.stdin.isTTY) terminalPairing = promptPairingsOnTerminal(access, { input: process.stdin, output: process.stdout });

  if (proxyListen) {
    const { host, port } = parseListen(proxyListen);
    if (!isLoopbackHost(host)) throw new Error(`TAU_HOST_PROXY_LISTEN must be a loopback address; ${host} is not. The proxy in front of it does the TLS.`);
    const proxy = web ? createServer(web.handler("proxy")) : createProtocolServer();
    socket.attach(proxy, "proxy");
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(port, host, () => resolve());
    });
    const address = proxy.address();
    console.log(`tau-host proxy listener on http://${host}:${typeof address === "object" && address ? address.port : port}`);
  }
  // Settings → Connections: the listeners beyond loopback, off until the owner turns them on.
  network = await HostNetworkAccess.open({ userData, attach: socket.attach, ...(web ? { web: web.handler } : {}), logger: hostLog });
  await refreshOrigins();
  for (const listener of network.state().listeners) hostLog.info("host-network.open-at-start", listener);
  networkPoll = setInterval(() => {
    void network?.poll().then(refreshOrigins).catch((error: unknown) => hostLog.warn("host-network.poll-failed", error));
    try {
      if (mainTls?.refresh() && listening) listening = { ...listening, fingerprint: mainTls.current.fingerprint };
    } catch (error: unknown) {
      hostLog.warn("host.tls.reload-failed", error);
    }
  }, NETWORK_POLL_MS);
  networkPoll.unref();

  compactor.start();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
  hostLog.error("headless.start.failed", error);
  console.error(error);
  process.exit(1);
});
