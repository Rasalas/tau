import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { HostEvent } from "../shared/contracts.js";
import { HOST_CAPABILITY, type HostPushEvent } from "../shared/host-transport.js";
import { WorkspaceIdentity, readOrCreateHostId } from "./workspace-identity.js";
import { EXTENSION_API_VERSION, type ExtensionHostVersions } from "../shared/extension-compat.js";
import { HostLog } from "./host-log.js";
import { HostJobRunner } from "./host-jobs.js";
import { HostPushLog } from "./host-push-log.js";
import { HostPushCoalescer } from "./host-push-coalescer.js";
import { createHostMethods } from "./host-methods.js";
import { hostTokenPath, readOrCreateHostToken } from "./host-token.js";
import { HostClientRegistry } from "./host-clients.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
import { createWebClientServer } from "./host-web-server.js";
import { parseListen } from "./host-listen.js";
import { resolveHostTls } from "./host-tls.js";
import { NO_BUNDLED_KITS, inspectBundledKits, loadBundledKitDesktopHalves, shippedHostExtensions } from "./bundled-kits.js";
import { loadHostExtensionPackages, inspectExtensionPackages } from "./extension-packages.js";
import { loadDesktopExtensions } from "./desktop-extensions.js";
import { installShellEnvironment } from "./shell-environment.js";
import { PiHost } from "./pi-host.js";
import { ClientCalls } from "./client-calls.js";
import { selectDefaultBackend } from "./runtime-adapters.js";
import { WINDOW_SERVICES_ID } from "./window-extensions.js";
import { primeOpenCodeCatalog } from "./pi-model-runtime.js";
import { ProjectHistory } from "./project-history.js";

/**
 * The host without a window: the same `PiHost` and the same method table,
 * reachable only over the socket transport. This is what a remote client
 * connects to, and what `scripts/remote-host-smoke.mjs` drives.
 */
const workspace = process.env.TAU_WORKSPACE || process.cwd();
const safeMode = process.env.TAU_NO_EXTENSIONS === "1";
const userData = process.env.TAU_USER_DATA || join(homedir(), ".tau", "headless");
const listen = process.env.TAU_HOST_LISTEN || "127.0.0.1:0";
// A supervised host is told which version it belongs to; a hand-started one
// reads npm's environment, as it always did.
const hostVersion = process.env.TAU_HOST_VERSION || process.env.npm_package_version || "0.0.0";
// dist-electron/main/headless.js -> the app root the kits are shipped in.
const appRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
// The built browser client, when there is one; `npm run build:web` writes it.
const webRoot = process.env.TAU_WEB_CLIENT || join(appRoot, "dist-web");

// Its own file: the window process writes host.log in the same directory.
const hostLog = new HostLog({ dir: join(userData, "logs"), fileName: "host-process.log" });
const workspaceIdentity = new WorkspaceIdentity(readOrCreateHostId(join(userData, "host-id")));
const pushLog = new HostPushLog();
/** Streamed text and tool output are merged here before they are numbered. */
const pushes = new HostPushCoalescer((event) => {
  const push = pushLog.record(event);
  socket?.deliver(push);
  return push.seq;
});
const jobs = new HostJobRunner((event) => broadcast(event));
/** The other direction: what a host extension asks the client's process to do. */
const clientCalls = new ClientCalls((event) => publish(event));
let socket: SocketHostTransport | undefined;

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

  let host: PiHost | undefined;
  let ready: Promise<unknown> | undefined;
  /** The socket transport reports its clients here; the host publishes the count. */
  const clients = new HostClientRegistry();
  const methods = createHostMethods({
    clientCalls,
    bootstrap: async () => {
      if (!host) {
        primeOpenCodeCatalog();
        host = new PiHost(workspace, publish, projectHistory, safeMode, false, {
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
          threadTrashDir: join(userData, "thread-trash"),
          // A window half of a kit lives in the client's process; this is the
          // only way a host without a window of its own reaches one. The folder
          // picker is the window's own, asked for the same way.
          platform: {
            callClient: (extensionId, command, input) => clientCalls.call(extensionId, command, input),
            pickDirectory: async (options) =>
              await clientCalls.call(WINDOW_SERVICES_ID, "pick-directory", options, 10 * 60_000) as string | undefined,
          },
          sessionUsageCachePath: join(userData, "session-usage.json"),
          sessionLineageCachePath: join(userData, "session-lineage.json"),
        });
        ready = host.start();
      }
      await ready;
      return host.bootstrap();
    },
    requireHost: async () => {
      if (!host) throw new Error("The host has not started yet; call bootstrap first.");
      await ready;
      return host;
    },
    host: () => host,
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
      await socket?.close();
      await host?.dispose().catch((error: unknown) => hostLog.error("host.shutdown.failed", error));
      process.exit(0);
    })();
  };
  // Not part of the client protocol: the supervisor that started this process
  // asks for a clean stop here before it reaches for a signal (ADR 0021).
  methods["host.shutdown"] = async () => {
    hostLog.info("host.shutdown.requested");
    // Answer first, leave afterwards.
    setTimeout(shutdown, 50).unref();
    return { stopping: true };
  };

  const token = readOrCreateHostToken();
  const { host: boundHost } = parseListen(listen);
  // TAU_HOST_TLS=1, or a certificate of the operator's own; the key stays under userData.
  const tls = resolveHostTls(process.env, { userData, bindHost: boundHost });
  // A built client turns this host into something a browser can open. Without
  // one the host is exactly what it was: a socket and nothing else.
  const web = existsSync(join(webRoot, "index.html"))
    ? createWebClientServer({ dir: webRoot, token, ...(tls ? { tls } : {}) })
    : undefined;
  socket = await startSocketHostTransport({
    listen,
    methods,
    pushLog,
    beforeReply: () => pushes.flush(),
    onSnapshotClient: () => pushes.resendWholeOutputs(),
    hostVersion,
    capabilities: [HOST_CAPABILITY.jobs, HOST_CAPABILITY.replay],
    token,
    allowNonLoopback: process.env.TAU_HOST_INSECURE === "1",
    ...(tls ? { tls } : {}),
    ...(web ? { attachTo: web.server } : {}),
    clients,
    logger: hostLog,
  });
  // The smoke test reads this line to learn the port when it asked for 0.
  console.log(`tau-host listening on ${socket.scheme}://${boundHost}:${socket.port}`);
  console.log(`token: ${hostTokenPath()} (copy it to the client machine, or pass it as TAU_HOST_TOKEN)`);
  if (tls) {
    const origin = tls.source === "self-signed" ? `self-signed, ${tls.created ? "created now" : "kept"} in ${tls.certPath}` : `from ${tls.certPath}`;
    console.log(`tls: certificate ${origin}`);
    console.log(`tls fingerprint: SHA256 ${tls.fingerprint} (a client pins it as TAU_HOST_FINGERPRINT)`);
    for (const warning of tls.warnings) console.warn(`tls warning: ${warning}`);
    hostLog.info("host.tls", { source: tls.source, fingerprint: tls.fingerprint, created: tls.created });
  }
  if (socket.warning) console.warn(`\nWARNING: ${socket.warning}\n`);
  if (web) {
    // The code lives in the fragment: no proxy, no access log and no Referer
    // ever carries it, and the page drops it before it renders anything.
    console.log(`web client: ${tls ? "https" : "http"}://${boundHost}:${socket.port}/#pair=${web.issueCode()} (single use, 10 minutes)`);
  } else {
    console.log(`web client: not built (run npm run build:web, or point TAU_WEB_CLIENT at a build)`);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
  hostLog.error("headless.start.failed", error);
  console.error(error);
  process.exit(1);
});
