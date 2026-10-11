import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import type { CommandLineState } from "../shared/window-shell.js";

/**
 * The `tau` command a person types in a terminal, installed from Settings:
 * a small launcher in the app's data folder that runs `bin/tau.mjs` on the
 * app's own binary (so Node is not needed), and a symlink to it in a folder on
 * PATH. Removing undoes only that: a link whose target carries the marker.
 */

export const LAUNCHER_MARKER = "Written by Tau: runs the app's command line on the app's own binary.";
/** The launcher is a few lines; never read a large file another command links to. */
const MAX_LAUNCHER_BYTES = 16 * 1024;

export interface CommandLinePorts {
  platform: NodeJS.Platform;
  home: string;
  /** PATH as the login shell gave it. */
  path(): string | undefined;
  /** `tau`, or `tau-dev` for Tau Dev. */
  name: string;
  /** Where the launcher is written: inside the app's data folder. */
  launcherDir: string;
  /** The app's own binary, run as Node, and `bin/tau.mjs` inside the app. */
  executable: string;
  entry: string;
  /** False for a build from source, where nothing may be linked into the user's folders. */
  available: boolean;
  /** Replaces the usual folders: tests and isolated instances link here and nowhere else. */
  folders?: readonly string[];
}

/** User-writable folders login shells commonly put on PATH, in preference order. */
export function linkFolders(home: string, platform: NodeJS.Platform): string[] {
  const own = [join(home, ".local", "bin"), join(home, "bin")];
  return platform === "darwin" ? [...own, "/opt/homebrew/bin", "/usr/local/bin"] : own;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function renderLauncher(executable: string, entry: string): string {
  return ["#!/bin/sh", `# ${LAUNCHER_MARKER}`, `ELECTRON_RUN_AS_NODE=1 exec ${quote(executable)} ${quote(entry)} "$@"`, ""].join("\n");
}

const exists = (path: string) => lstat(path).then(() => true, () => false);
const writable = (path: string) => access(path, constants.W_OK).then(() => true, () => false);

/** A folder a link can go into: it is there and writable, or the nearest folder above it is. */
async function usable(folder: string): Promise<boolean> {
  for (let current = folder; ; current = dirname(current)) {
    if (await exists(current)) return (await stat(current).then((info) => info.isDirectory(), () => false)) && writable(current);
    if (dirname(current) === current) return false;
  }
}

export function createCommandLine(ports: CommandLinePorts) {
  const supported = ports.available && ports.platform !== "win32";
  const folders = ports.folders ?? linkFolders(ports.home, ports.platform);
  const launcher = join(ports.launcherDir, ports.name);
  const onPath = () => (ports.path() ?? "").split(delimiter).filter(Boolean);

  /** The launcher a link of ours points at, found by the marker it carries. */
  async function ourLauncher(link: string): Promise<string | undefined> {
    try {
      const target = await readlink(link);
      const info = await stat(link).catch(() => undefined);
      // Our own link whose launcher is gone: Install writes the launcher again.
      if (!info) return target === launcher ? target : undefined;
      if (!info.isFile() || info.size > MAX_LAUNCHER_BYTES) return undefined;
      return (await readFile(link, "utf8")).includes(LAUNCHER_MARKER) ? target : undefined;
    } catch {
      return undefined;
    }
  }

  async function installedLinks(): Promise<string[]> {
    const found: string[] = [];
    for (const folder of folders) {
      const link = join(folder, ports.name);
      if (await ourLauncher(link)) found.push(link);
    }
    return found;
  }

  /** The folder Install would use: one already on PATH first, and never one holding another command of that name. */
  async function chooseFolder(): Promise<string | undefined> {
    const listed = new Set(onPath());
    const ordered = [...folders.filter((folder) => listed.has(folder)), ...folders.filter((folder) => !listed.has(folder))];
    for (const folder of ordered) {
      if (!(await exists(join(folder, ports.name))) && await usable(folder)) return folder;
    }
    return undefined;
  }

  async function refreshLauncher(): Promise<void> {
    const wanted = renderLauncher(ports.executable, ports.entry);
    if (await readFile(launcher, "utf8").catch(() => undefined) === wanted) return;
    await mkdir(ports.launcherDir, { recursive: true });
    await writeFile(launcher, wanted, { mode: 0o755 });
    await chmod(launcher, 0o755);
  }

  async function state(): Promise<CommandLineState> {
    if (!supported) return { supported: false, name: ports.name, onPath: false };
    const [installed] = await installedLinks();
    // The first command of that name a new terminal finds.
    let first: string | undefined;
    for (const folder of onPath()) {
      const candidate = join(folder, ports.name);
      if (await exists(candidate)) { first = candidate; break; }
    }
    const ours = first ? Boolean(await ourLauncher(first)) : false;
    if (installed) {
      // An app that moved or updated points the launcher at itself again.
      await refreshLauncher().catch(() => undefined);
      return { supported, name: ports.name, installedPath: installed, onPath: ours, ...(first && !ours ? { otherPath: first } : {}) };
    }
    const folder = await chooseFolder();
    return {
      supported, name: ports.name, onPath: false,
      ...(folder ? { target: { folder, onPath: onPath().includes(folder) } } : {}),
      ...(first ? { otherPath: first } : {}),
    };
  }

  return {
    state,

    /** Links the launcher into `folder`, which must be one of the folders Install offers. */
    async install(folder: string): Promise<CommandLineState> {
      if (!supported) throw new Error("The command line is not installed from this build.");
      if (!folders.includes(folder)) throw new Error(`${folder} is not a folder Tau links into.`);
      const link = join(folder, ports.name);
      const current = await ourLauncher(link);
      if (!current && await exists(link)) throw new Error(`Another ${ports.name} command is already at ${link}.`);
      if (!current && !await usable(folder)) throw new Error(`${folder} is not writable.`);
      await refreshLauncher();
      if (current === launcher) return state();
      await mkdir(folder, { recursive: true });
      if (current) await rm(link);
      await symlink(launcher, link);
      return state();
    },

    async remove(): Promise<CommandLineState> {
      if (!supported) return state();
      for (const link of await installedLinks()) await rm(link);
      const text = await readFile(launcher, "utf8").catch(() => undefined);
      if (text?.includes(LAUNCHER_MARKER)) await rm(launcher);
      return state();
    },
  };
}

/**
 * The command for the app on screen. `TAU_COMMAND_DIR` links into that one
 * folder instead of the user's own, and lets a build from source try it.
 */
export function appCommandLine(app: { userData: string; packaged: boolean; resourcesPath: string; appPath: string; name: string }, env: NodeJS.ProcessEnv = process.env) {
  const folder = env.TAU_COMMAND_DIR;
  return createCommandLine({
    platform: process.platform,
    home: homedir(),
    path: () => process.env.PATH,
    name: app.name,
    launcherDir: join(app.userData, "bin"),
    executable: process.execPath,
    entry: app.packaged ? join(app.resourcesPath, "app.asar.unpacked", "bin", "tau.mjs") : join(app.appPath, "bin", "tau.mjs"),
    available: app.packaged || Boolean(folder),
    ...(folder ? { folders: [folder] } : {}),
  });
}

export type CommandLine = ReturnType<typeof createCommandLine>;
