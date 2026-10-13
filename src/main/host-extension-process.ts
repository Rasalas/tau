import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerHostExtensionOptions } from "./host-extension-isolation.js";
import type { HostToWorkerMessage, WorkerBootstrap } from "./host-extension-worker-protocol.js";

async function checkDirectoryLinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Extension folders must not contain symbolic links");
    if (entry.isDirectory()) await checkDirectoryLinks(join(directory, entry.name));
  }
}

/** Same RPC transport as a bundled worker, with Node enforcing file access. */
export async function startExtensionProcess(supervisor: string, entry: string, boot: WorkerBootstrap, options: WorkerHostExtensionOptions): Promise<EventEmitter & {
  postMessage(message: HostToWorkerMessage): void;
  terminate(): Promise<void>;
}> {
  const limits = options.resourceLimits;
  const supervisorPath = await realpath(supervisor);
  const workerPath = await realpath(entry);
  const bundlePath = await realpath(options.file);
  const packagePath = await realpath(options.packageDirectory!);
  if ([supervisorPath, workerPath, bundlePath, packagePath, options.packageDirectory!, boot.stateDir].some((path) => path.includes("*"))) {
    throw new Error("Extension paths must not contain permission wildcards");
  }
  await checkDirectoryLinks(packagePath);
  if ((await lstat(boot.stateDir).catch(() => undefined))?.isSymbolicLink()) {
    throw new Error("Extension folders must not contain symbolic links");
  }
  await mkdir(boot.stateDir, { recursive: true, mode: 0o700 });
  const statePath = await realpath(boot.stateDir);
  if (statePath.includes("*")) throw new Error("Extension paths must not contain permission wildcards");
  await checkDirectoryLinks(statePath);
  const execArgv = [
    "--permission",
    "--allow-worker",
    `--allow-fs-read=${supervisorPath}`,
    `--allow-fs-read=${workerPath}`,
    `--allow-fs-read=${bundlePath}`,
    `--allow-fs-read=${packagePath}`,
    `--allow-fs-read=${options.packageDirectory!}`,
    `--allow-fs-read=${statePath}`,
    `--allow-fs-write=${statePath}`,
    `--max-old-space-size=${limits?.maxOldGenerationSizeMb ?? 256}`,
    `--max-semi-space-size=${limits?.maxYoungGenerationSizeMb ?? 32}`,
    ...(limits?.stackSizeMb ? [`--stack-size=${limits.stackSizeMb * 1024}`] : []),
  ];
  if (boot.permissions.includes("process")) execArgv.push("--allow-child-process");
  if (boot.permissions.includes("native")) execArgv.push("--allow-addons");
  if (process.allowedNodeEnvironmentFlags.has("--allow-net") && boot.permissions.includes("network")) execArgv.push("--allow-net");
  const child = fork(supervisorPath, [], {
    execArgv,
    // No host keys, runtime homes, preload flags or inherited file handles.
    env: { ELECTRON_RUN_AS_NODE: "1" },
    cwd: packagePath,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    serialization: "advanced",
  });
  const transport = new EventEmitter();
  let diagnostic = "";
  child.stderr?.on("data", (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-8192); });
  child.on("message", (message) => transport.emit("message", message));
  child.on("error", (error) => transport.emit("error", error));
  child.on("exit", (code, signal) => {
    if (signal || code) transport.emit("error", new Error(diagnostic.trim() || `Extension process exited: ${signal ?? code}`));
    transport.emit("exit", code);
  });
  child.send({ entry: workerPath, boot: { ...boot, file: bundlePath, stateDir: statePath }, resourceLimits: options.resourceLimits });
  return Object.assign(transport, {
    postMessage(message: HostToWorkerMessage): void {
      if (child.connected) child.send(message, (error) => { if (error) transport.emit("error", error); });
    },
    async terminate(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGKILL");
      await exited;
    },
  });
}
