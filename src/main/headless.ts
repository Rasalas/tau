import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { Server as TlsServer } from "node:tls";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { getAgentDir, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { HostEvent } from "../shared/contracts.js";
import { HOST_CAPABILITY, HOST_ERROR, type HostPushEvent } from "../shared/host-transport.js";
import { pairingUrl, type PairingEndpoint } from "../shared/connections.js";
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
import { publishedEndpoints, type HostConnectionsService, type HostListenInfo } from "./host-connections.js";
import { isHostOwner } from "./host-invocation.js";
import { HostClientRegistry } from "./host-clients.js";
import { hostAllowedOrigins } from "./host-origin.js";
import { createProtocolServer, startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
import { createWebClientServer } from "./host-web-server.js";
import { isLoopbackHost, parseListen, rememberPort, rememberedPort, stickyListen } from "./host-listen.js";
import { HostTlsReloader, resolveHostTls } from "./host-tls.js";
import { HostNetworkAccess } from "./host-network.js";
import { ServiceAnnouncer, discoverHosts, machineDisplayName } from "./host-discovery.js";
import { TAU_SERVICE_TYPE, isServiceType } from "../shared/discovery.js";
import { NetworkContributions } from "./host-network-contributions.js";
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
import { resolveStartupWorkspace } from "./startup-workspace.js";
import { IdleHeapCompactor } from "./host-idle-compaction.js";
import { defaultHostConfigManager } from "./host-config.js";
import { KeepAwake } from "./keep-awake.js";
import { HostServiceManager } from "./host-service.js";
import { DisplayWindow } from "./display-window.js";
import { HostMachines } from "./host-machines.js";
import { HOST_SERVICE_ENV } from "./host-service-units.js";
import { hostDescriptorPath, readHostDescriptor, retireHost, writeHostDescriptor } from "./host-process-supervisor.js";

/**
 * The host without a window: the same `PiHost` and the same method table,
 * reachable only over the socket transport. This is what a remote client
 * connects to, and what `scripts/remote-host-smoke.mjs` drives.
 */
const requestedWorkspace = process.env.TAU_WORKSPACE || undefined;
const safeMode = process.env.TAU_NO_EXTENSIONS === "1";
const userData = process.env.TAU_USER_DATA || join(homedir(), ".tau", "headless");
const listen = process.env.TAU_HOST_LISTEN || "127.0.0.1:0";
// A loopback listener for a reverse proxy on this machine; every peer on it counts as remote.
const proxyListen = process.env.TAU_HOST_PROXY_LISTEN;
// Isolated instances and tests announce and browse `_tau-test._tcp`, never the real type.
const bonjourType = process.env.TAU_BONJOUR_SERVICE_TYPE || TAU_SERVICE_TYPE;
if (!isServiceType(bonjourType)) throw new Error(`TAU_BONJOUR_SERVICE_TYPE must look like _name._tcp; ${bonjourType} does not.`);
/** How often network access looks again at Tailscale's addresses and the certificate files. */
const NETWORK_POLL_MS = 60_000;
// dist-electron/main/headless.js -> the app root the kits are shipped in.
const appRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// A supervised host is told which version it belongs to; a hand-started one
// reads npm's environment. A service host reads the app it runs from, so an
// update in place is a new version after a restart without touching the unit.
const hostVersion = process.env.TAU_HOST_VERSION || process.env.npm_package_version || packageVersion(appRoot) || "0.0.0";
/** Set in a service's unit: this host writes `host.json` itself and takes over from the host it names. */
const serviceKind = process.env[HOST_SERVICE_ENV] || undefined;
/** Started by a window's supervisor (which names the version) or by a service manager, not by hand. */
const supervised = Boolean(process.env.TAU_HOST_VERSION || serviceKind);
/** Spawned by a window's own supervisor: a client is already on its way. */
const windowSpawned = Boolean(process.env.TAU_HOST_VERSION) && !serviceKind;
// A service runs from the home folder and nobody names a workspace for it: it opens the last project.
const workspace = requestedWorkspace ?? (serviceKind ? undefined : process.cwd());
// The built browser client, when there is one; `npm run build:web` writes it.
const webRoot = process.env.TAU_WEB_CLIENT || join(appRoot, "dist-web");

// Its own file: the window process writes host.log in the same directory.
const hostLog = new HostLog({ dir: join(userData, "logs"), fileName: "host-process.log" });
const hostId = readOrCreateHostId(join(userData, "host-id"));
/** One name for this machine wherever a person reads it: Bonjour, Machines, a pairing link. The host name stays an address. */
const machineName = machineDisplayName();
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
  keepAwake.observe(event);
  broadcast(event);
}

function packageVersion(root: string): string | undefined {
  try {
    const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown }).version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

function portIsFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

/**
 * A service host takes over from the host `host.json` names — the one a
 * window started, or its own previous run — and asks for that host's port
 * again, so the clients of the host it replaces reconnect to it unchanged.
 */
async function takeOverListen(): Promise<string> {
  const previous = await readHostDescriptor(userData);
  if (!previous || previous.pid === process.pid) return listen;
  const token = await readFile(previous.tokenPath, "utf8").then((value) => value.trim()).catch(() => "");
  if (token) {
    hostLog.info("host.service.take-over", { pid: previous.pid, url: previous.url, service: previous.service });
    await retireHost(previous, token);
  }
  const { host: bindHost, port } = parseListen(listen);
  let wanted = 0;
  try { wanted = Number(new URL(previous.url).port) || 0; } catch { /* no port to keep */ }
  if (port !== 0 || wanted === 0) return listen;
  return await portIsFree(bindHost, wanted) ? `${bindHost.includes(":") ? `[${bindHost}]` : bindHost}:${wanted}` : listen;
}

/** "Keep this machine awake while turns run", read from this machine's config when a turn starts. */
const keepAwake = new KeepAwake({
  enabled: async () => (await defaultHostConfigManager.read()).hostKeepAwake === true,
  logger: hostLog,
});

const versions: ExtensionHostVersions = { tau: hostVersion, pi: PI_VERSION, api: EXTENSION_API_VERSION };
/** Where the kits Tau ships are read from; a headless host runs from the same tree. */
const kitOptions = { appPath: appRoot, cacheDir: join(userData, "host-extensions"), versions };
const unsupported = (what: string) => () => { throw new Error(`${what} needs a desktop window.`); };

async function main(): Promise<void> {
  await installShellEnvironment().catch((error: unknown) => hostLog.warn("shell-environment.failed", error));
  const projectHistory = new ProjectHistory(join(userData, "projects.json"), undefined, hostLog, (path) => workspaceIdentity.ref(path));
  await projectHistory.load();
  const startupWorkspace = workspace ?? resolveStartupWorkspace(undefined, projectHistory.list()).cwd;

  /** The socket transport reports its clients here; the host publishes the count. */
  const clients = new HostClientRegistry();
  // What packages add to network access; it waits for the listeners below.
  const networkContributions = new NetworkContributions({ storePath: join(userData, "network-kept.json"), logger: hostLog });
  await networkContributions.load();
  // Other machines this host's agents reach, with keys the owner's window handed over (ADR 0027).
  const machines = await HostMachines.open({ path: join(userData, "host-machines.json"), logger: hostLog, ownId: hostId });
  const started = new HostStart(() => {
    primeOpenCodeCatalog();
    return new PiHost(startupWorkspace, publish, projectHistory, safeMode, false, {
      defaultBackendKind: selectDefaultBackend(undefined, { safeMode }),
      hostExtensions: safeMode ? [] : shippedHostExtensions(kitOptions, (label, detail) => hostLog.warn(label, detail)),
      hostExtensionPackages: (cwd: string) => loadHostExtensionPackages(cwd, getAgentDir(), {
        versions,
        cacheDir: join(userData, "host-extensions"),
      }),
      logger: hostLog,
      workspaceIdentity,
      clients,
      network: networkContributions.services,
      machines: machines.services,
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
        callClient: (extensionId, command, input, options) => clientCalls.call(extensionId, command, input, options),
        clientWindow: (extensionId) => clientCalls.clientWindow(extensionId),
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
    onChange: () => { publish({ type: "connections-changed" }); terminalPairing?.(); clients.devicesChanged(); },
    audit: (entry) => (entry.allowed ? hostLog.info("access.action", entry) : hostLog.warn("access.refused", entry)),
    threadTitle: (threadId) => started.current()?.threadTitle(threadId),
  });
  clients.setDeviceSource(() => access.devices());
  // Requests nobody answered and tokens unused past their timeout end here, not only at the next hello.
  setInterval(() => access.sweep(), 60_000).unref();
  // The machine's service for this userData, whether or not this host is it (Settings → Connections).
  const service = new HostServiceManager({
    execPath: process.execPath,
    entry: fileURLToPath(import.meta.url),
    userData,
    // Ending a Windows task leaves the host it started: this one stops itself, another is asked to.
    retireHost: async () => {
      const running = await readHostDescriptor(userData);
      if (!running?.service) return;
      if (running.pid === process.pid) { setTimeout(() => shutdown(), 1_000); return; }
      const token = await readFile(running.tokenPath, "utf8").then((value) => value.trim()).catch(() => "");
      if (token) await retireHost(running, token);
    },
  });
  // A systemd service host with an invisible display starts its window when a call needs one.
  if (serviceKind === "systemd" && await service.installedDisplay()) {
    const window = new DisplayWindow({ start: () => service.startWindow(), stop: () => service.stopWindow() }, {
      log: (event, detail) => hostLog.info(event, detail),
    });
    clientCalls.setWindowLauncher(window);
    hostLog.info("host.display", { display: process.env.DISPLAY });
  }
  let listening: HostListenInfo | undefined;
  let network: HostNetworkAccess | undefined;
  let mainTls: HostTlsReloader | undefined;
  const reloadCertificates = async (): Promise<{ changed: boolean }> => {
    const own = mainTls?.reload() ?? false;
    const fromNetwork = network ? (await network.reloadCertificate()).changed : false;
    if (listening && mainTls) listening = { ...listening, fingerprint: mainTls.current.fingerprint, publicKey: mainTls.current.publicKey };
    return { changed: own || fromNetwork };
  };
  const staticOrigins = hostAllowedOrigins();
  /** Origins of the published endpoints; the socket accepts pages opened at any of them. */
  let publishedOrigins: string[] = [];
  /** The addresses beyond loopback; a hello names them to a window that saved this host. */
  let networkEndpoints: PairingEndpoint[] = [];
  const connectionsService = (): HostConnectionsService => ({
    access,
    listen: () => listening,
    hostId,
    hostName: machineName,
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
    discover: async (options) => ({ ...(await discoverHosts(bonjourType, { ...options, ownHostId: hostId, logger: hostLog })), serviceType: bonjourType }),
    published: () => networkContributions.endpoints(),
  });
  const refreshOrigins = async (): Promise<void> => {
    const published = await publishedEndpoints(connectionsService()).catch((error: unknown) => {
      hostLog.warn("host-network.origins-failed", error);
      return undefined;
    });
    if (!published) return;
    publishedOrigins = published.origins;
    networkEndpoints = published.network;
  };
  const methods = createHostMethods({
    clientCalls,
    connections: () => connectionsService(),
    service: () => service,
    machines: () => machines,
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
      // A host on its way out starts no window on the display.
      clientCalls.setWindowLauncher(undefined);
      clientCalls.dispose();
      machines.close();
      compactor.dispose();
      keepAwake.dispose();
      clearInterval(networkPoll);
      await network?.close().catch((error: unknown) => hostLog.warn("host-network.close-failed", error));
      await socket?.close();
      // Only a service host wrote the file; a window's supervisor removes its own.
      if (serviceKind && (await readHostDescriptor(userData))?.pid === process.pid) {
        await rm(hostDescriptorPath(userData), { force: true }).catch(() => undefined);
      }
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


  // Kept across restarts, so a tab or phone on this port reconnects instead of needing a new pairing.
  const portFile = join(userData, "host-port");
  const listenOn = await stickyListen(serviceKind ? await takeOverListen() : listen, rememberedPort(portFile), portIsFree);
  const { host: boundHost } = parseListen(listenOn);
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
    listen: listenOn,
    methods: compactor.observe(methods),
    pushLog,
    beforeReply: () => pushes.flush(),
    onSnapshotClient: () => pushes.resendWholeOutputs(),
    onThreadsSubscribed: (sessionIds) => pushes.resendWholeOutputs(sessionIds),
    hostVersion,
    capabilities: [HOST_CAPABILITY.jobs, HOST_CAPABILITY.replay],
    host: { id: hostId, name: machineName, endpoints: () => networkEndpoints },
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
  listening = { scheme: socket.scheme, host: boundHost, port: socket.port, webClient: web !== undefined, ...(tls ? { fingerprint: tls.fingerprint, publicKey: tls.publicKey } : {}) };
  console.log(`tau-host listening on ${socket.scheme}://${boundHost}:${socket.port}`);
  rememberPort(portFile, socket.port);
  if (serviceKind) {
    // Nobody supervises a service host: it tells a window where it is itself.
    await writeHostDescriptor(userData, {
      pid: process.pid,
      url: `${socket.scheme}://${boundHost.includes(":") ? `[${boundHost}]` : boundHost}:${socket.port}`,
      tokenPath: tokenFile.path,
      startedAt: new Date().toISOString(),
      version: hostVersion,
      service: serviceKind,
    });
    hostLog.info("host.service.started", { service: serviceKind, pid: process.pid, port: socket.port, version: hostVersion });
  }
  console.log(`token: ${tokenFile.path} (copy it to the client machine, or pass it as TAU_HOST_TOKEN)`);
  if (tls) {
    const origin = tls.source === "self-signed" ? `self-signed, ${tls.created ? "created now" : "kept"} in ${tls.certPath}` : `from ${tls.certPath}`;
    console.log(`tls: certificate ${origin}`);
    console.log(`tls fingerprint: SHA256 ${tls.fingerprint} (browsers show it; a renewal changes it)`);
    console.log(`tls public key: SHA256 ${tls.publicKey} (a client pins it as TAU_HOST_PUBLIC_KEY; a renewal keeps it)`);
    for (const warning of tls.warnings) console.warn(`tls warning: ${warning}`);
    hostLog.info("host.tls", { source: tls.source, fingerprint: tls.fingerprint, publicKey: tls.publicKey, created: tls.created });
  }
  if (socket.warning) console.warn(`\nWARNING: ${socket.warning}\n`);
  // The code lives in the fragment: no proxy, no access log and no Referer
  // ever carries it, and the page drops it before it renders anything. It
  // only asks: the owner still allows the device (ADR 0024). A window's host or
  // a service is paired from Settings → Connections, so it creates no link here.
  if (!supervised) {
    const { code } = access.createLink();
    const page = `${tls ? "https" : "http"}://${boundHost}:${socket.port}/`;
    const link = pairingUrl(page, { code, ...(tls ? { fingerprint: tls.fingerprint, publicKey: tls.publicKey } : {}), hostId, hostName: machineName });
    console.log(`${web ? "web client" : "pairing link"}: ${link} (single use, 10 minutes; allow the device in Settings → Connections${process.stdin.isTTY ? " or here" : ""})`);
  }
  if (!web) console.log(`web client: not built (run npm run build:web, or point TAU_WEB_CLIENT at a build)`);
  // A host started by hand in a terminal asks there; a supervised one has a window to ask in.
  if (process.stdin.isTTY) terminalPairing = promptPairingsOnTerminal(access, { input: process.stdin, output: process.stdout });
  // A window that spawned this host asks for its bootstrap next; the start need not wait for that call.
  // A failed start reaches that call too, so the error is not lost here.
  if (windowSpawned) void started.require().catch(() => undefined);

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
  // Its state reaches an owner's window the way every other Connections change does.
  const announcer = new ServiceAnnouncer({ logger: hostLog, onChange: () => publish({ type: "connections-changed" }) });
  network = await HostNetworkAccess.open({
    userData,
    attach: socket.attach,
    ...(web ? { web: web.handler } : {}),
    logger: hostLog,
    bonjour: { announcer, serviceType: bonjourType, hostId, name: machineName },
    proxyHeld: () => networkContributions.proxyHeld,
  });
  networkContributions.bind({
    state: () => network?.state(),
    reconcile: async () => { await network?.reconcile(); await refreshOrigins(); },
    endpointsChanged: refreshOrigins,
  });
  await refreshOrigins();
  for (const listener of network.state().listeners) hostLog.info("host-network.open-at-start", listener);
  networkPoll = setInterval(() => {
    void network?.poll().then(refreshOrigins).catch((error: unknown) => hostLog.warn("host-network.poll-failed", error));
    try {
      if (mainTls?.refresh() && listening) listening = { ...listening, fingerprint: mainTls.current.fingerprint, publicKey: mainTls.current.publicKey };
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
