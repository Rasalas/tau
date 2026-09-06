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
import { createHostMethods } from "./host-methods.js";
import { hostTokenPath, readOrCreateHostToken } from "./host-token.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
import { parseListen } from "./host-listen.js";
import { shippedHostExtensions } from "./extensions/index.js";
import { NO_BUNDLED_KITS, inspectBundledKits, loadBundledKitDesktopHalves } from "./bundled-kits.js";
import { loadHostExtensionPackages, inspectExtensionPackages } from "./extension-packages.js";
import { loadDesktopExtensions } from "./desktop-extensions.js";
import { installShellEnvironment } from "./shell-environment.js";
import { PiHost } from "./pi-host.js";
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
const hostVersion = process.env.npm_package_version || "0.0.0";
// dist-electron/main/headless.js -> the app root the kits are shipped in.
const appRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const hostLog = new HostLog({ dir: join(userData, "logs") });
const workspaceIdentity = new WorkspaceIdentity(readOrCreateHostId(join(userData, "host-id")));
const pushLog = new HostPushLog();
const jobs = new HostJobRunner((event) => broadcast(event));
let socket: SocketHostTransport | undefined;

function broadcast(event: HostPushEvent): void {
  socket?.deliver(pushLog.record(event));
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
  const methods = createHostMethods({
    bootstrap: async () => {
      if (!host) {
        host = new PiHost(workspace, publish, projectHistory, safeMode, false, {
          hostExtensions: safeMode ? [] : shippedHostExtensions(kitOptions, (label, detail) => hostLog.warn(label, detail)),
          hostExtensionPackages: (cwd: string) => loadHostExtensionPackages(cwd, getAgentDir(), {
            versions,
            cacheDir: join(userData, "host-extensions"),
          }),
          logger: hostLog,
          workspaceIdentity,
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
      loadDesktopExtensions: async (cwd, sharedExports) => {
        const [kits, result] = await Promise.all([
          safeMode ? { bundles: [], errors: [] } : loadBundledKitDesktopHalves({ ...kitOptions, sharedExports }),
          loadDesktopExtensions(cwd, getAgentDir(), { sharedExports, versions }),
        ]);
        return { ...result, bundles: [...kits.bundles, ...result.bundles], errors: [...kits.errors, ...result.errors] };
      },
      rebuildWorkbench: unsupported("Rebuilding the workbench"),
      relaunchWorkbench: unsupported("Relaunching the workbench"),
      installUpdate: unsupported("Installing an update"),
    },
  });

  socket = await startSocketHostTransport({
    listen,
    methods,
    pushLog,
    hostVersion,
    capabilities: [HOST_CAPABILITY.jobs, HOST_CAPABILITY.replay],
    token: readOrCreateHostToken(),
    allowNonLoopback: process.env.TAU_HOST_INSECURE === "1",
    logger: hostLog,
  });
  // The smoke test reads this line to learn the port when it asked for 0.
  console.log(`tau-host listening on ws://${parseListen(listen).host}:${socket.port}`);
  console.log(`token: ${hostTokenPath()} (copy it to the client machine, or pass it as TAU_HOST_TOKEN)`);

  const shutdown = () => {
    void (async () => {
      await socket?.close();
      await host?.dispose().catch((error: unknown) => hostLog.error("host.shutdown.failed", error));
      process.exit(0);
    })();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error: unknown) => {
  hostLog.error("headless.start.failed", error);
  console.error(error);
  process.exit(1);
});
