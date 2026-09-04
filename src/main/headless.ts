import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { HostEvent } from "../shared/contracts.js";
import { HOST_CAPABILITY, type HostPushEvent } from "../shared/host-transport.js";
import { EXTENSION_API_VERSION, type ExtensionHostVersions } from "../shared/extension-compat.js";
import { HostLog } from "./host-log.js";
import { HostJobRunner } from "./host-jobs.js";
import { HostPushLog } from "./host-push-log.js";
import { createHostMethods } from "./host-methods.js";
import { readOrCreateHostToken } from "./host-token.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
import { bundledHostExtensions } from "./extensions/index.js";
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

const hostLog = new HostLog({ dir: join(userData, "logs") });
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
const unsupported = (what: string) => () => { throw new Error(`${what} needs a desktop window.`); };

async function main(): Promise<void> {
  await installShellEnvironment().catch((error: unknown) => hostLog.warn("shell-environment.failed", error));
  const projectHistory = new ProjectHistory(join(userData, "projects.json"), undefined, hostLog);
  await projectHistory.load();

  let host: PiHost | undefined;
  let ready: Promise<unknown> | undefined;
  const methods = createHostMethods({
    bootstrap: async () => {
      if (!host) {
        host = new PiHost(workspace, publish, projectHistory, safeMode, false, {
          hostExtensions: safeMode ? [] : bundledHostExtensions(),
          hostExtensionPackages: (cwd: string) => loadHostExtensionPackages(cwd, getAgentDir(), {
            versions,
            cacheDir: join(userData, "host-extensions"),
          }),
          logger: hostLog,
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
      inspectExtensions: async (cwd) => inspectExtensionPackages(cwd, getAgentDir(), { versions }),
      loadDesktopExtensions: async (cwd, sharedExports) => loadDesktopExtensions(cwd, getAgentDir(), { sharedExports, versions }),
      rebuildWorkbench: unsupported("Rebuilding the workbench"),
      relaunchWorkbench: unsupported("Relaunching the workbench"),
    },
  });

  socket = await startSocketHostTransport({
    listen,
    methods,
    pushLog,
    hostVersion,
    capabilities: [HOST_CAPABILITY.jobs, HOST_CAPABILITY.replay],
    token: readOrCreateHostToken(),
    logger: hostLog,
  });
  // The smoke test reads this line to learn the port when it asked for 0.
  console.log(`tau-host listening on ws://127.0.0.1:${socket.port}`);

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
