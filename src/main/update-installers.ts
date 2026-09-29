import { spawn } from "node:child_process";
import { accessSync, chmodSync, closeSync, constants, copyFileSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { UpdateChannel } from "../shared/app-version.js";
import type { HostUpdateMethod } from "../shared/host-updates.js";
import { UNPACKED_UPDATES, linuxInstall } from "./release-feed.js";

/**
 * How a host process installs a verified download of its own app (K103).
 * One per kind of install; `update-helper` is the root half of the .deb's.
 */

/** A download whose size and SHA-512 matched its release. */
export interface StagedUpdate {
  version: string;
  channel: UpdateChannel;
  file: string;
  sha512: string;
  size?: number;
}

/** What the host does once an install succeeded: start again, leave for an installer that starts it, or nothing. */
export type AfterInstall = "restart" | "exit" | "none";

export interface UpdateInstaller {
  method: HostUpdateMethod;
  /** Why this install cannot replace itself as things stand; asked before a download. */
  blocked(): Promise<string | undefined>;
  install(update: StagedUpdate): Promise<AfterInstall>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** What the installers do to the machine; tests replace all of it. */
export interface InstallerSystem {
  /** Without a shell; `stdinFile` is the child's standard input. A missing command is 127. */
  run(command: string, args: readonly string[], options?: { stdinFile?: string; timeoutMs?: number }): Promise<CommandResult>;
  /** Starts a process that outlives this one. */
  spawnDetached(command: string, args: readonly string[], options?: { verbatim?: boolean }): void;
  exists(path: string): boolean;
  writable(path: string): boolean;
  mkdtemp(prefix: string): string;
  rename(from: string, to: string): void;
  copy(from: string, to: string): void;
  chmod(path: string, mode: number): void;
  remove(path: string): void;
  list(path: string): string[];
  readText(path: string): string | undefined;
}

/** The root helper the .deb installs, and the polkit action that lets it run without a password. */
export const UPDATE_HELPER = "/opt/Tau/bin/tau-update-helper";
export const UPDATE_POLKIT_ACTION = "de.tbuck.tau.update";
const PKEXEC = "/usr/bin/pkexec";
const PKCHECK = "/usr/bin/pkcheck";

function lastLine(text: string): string {
  return (text.trim().split("\n").filter(Boolean).at(-1) ?? "").replace(/\.$/u, "");
}

/**
 * The .deb: the root helper checks the package against the release again and
 * installs it. polkit lets the machine's administrators run exactly that
 * helper without a password; nothing else runs as root.
 */
export function debInstaller(system: InstallerSystem, pid: number = process.pid): UpdateInstaller {
  return {
    method: "deb",
    async blocked() {
      if (!system.exists(UPDATE_HELPER)) {
        return "This Tau was installed before it carried its update helper. Install the next version once by hand (sudo apt install ./Tau_<version>_amd64.deb); it updates itself from then on.";
      }
      if (!system.exists(PKEXEC)) return "pkexec is not installed (apt install pkexec), so the update helper cannot run.";
      // 0: allowed without a password. Anything else asks, and a service host has nobody to ask.
      if (system.exists(PKCHECK)) {
        const check = await system.run(PKCHECK, ["--action-id", UPDATE_POLKIT_ACTION, "--process", String(pid)], { timeoutMs: 15_000 });
        if (check.code !== 0) return "Installing needs an administrator: this user is not in the sudo, admin, wheel or tau-update group. Update from a Tau window on this machine, which asks for the password.";
      }
      return undefined;
    },
    async install(update) {
      const args = ["--disable-internal-agent", UPDATE_HELPER, "install", "--version", update.version, "--channel", update.channel];
      const result = await system.run(PKEXEC, args, { stdinFile: update.file, timeoutMs: 15 * 60_000 });
      if (result.code === 0) return "restart";
      if (result.code === 126 || result.code === 127) throw new Error("polkit did not allow the update helper; nothing was installed.");
      throw new Error(lastLine(result.stderr) || `The update helper stopped with ${result.code}; nothing was installed.`);
    },
  };
}

/** The AppImage: the new file takes the old one's place in the same folder. */
export function appImageInstaller(system: InstallerSystem, appImage: string): UpdateInstaller {
  return {
    method: "appimage",
    async blocked() {
      return system.writable(dirname(appImage)) && system.writable(appImage) ? undefined : `${appImage} is not writable for this user, so it cannot be replaced.`;
    },
    async install(update) {
      const next = `${appImage}.update-${process.pid}`;
      try {
        system.copy(update.file, next);
        system.chmod(next, 0o755);
        system.rename(next, appImage);
      } finally {
        system.remove(next);
      }
      return "restart";
    },
  };
}

/** `…/Tau.app/Contents/MacOS/Tau` → `…/Tau.app`. */
export function macBundle(execPath: string): string | undefined {
  const match = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/u.exec(execPath);
  return match?.[1];
}

async function plistValue(system: InstallerSystem, bundle: string, key: string): Promise<string | undefined> {
  const result = await system.run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", join(bundle, "Contents", "Info.plist")]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** The team that signed a bundle; undefined for an unsigned or ad-hoc one. */
async function signingTeam(system: InstallerSystem, bundle: string): Promise<string | undefined> {
  const result = await system.run("/usr/bin/codesign", ["-dv", "--verbose=2", bundle]);
  const team = /^TeamIdentifier=(.+)$/mu.exec(`${result.stdout}\n${result.stderr}`)?.[1]?.trim();
  return team && team !== "not set" ? team : undefined;
}

/**
 * macOS: the zip is unpacked beside the app, checked (bundle id, version and,
 * for a signed Tau, the same team's valid signature) and swapped in, as
 * Squirrel.Mac would after a quit. Only where the user owns the app.
 */
export function macInstaller(system: InstallerSystem, bundle: string): UpdateInstaller {
  return {
    method: "mac",
    async blocked() {
      return system.writable(bundle) && system.writable(dirname(bundle))
        ? undefined
        : `${bundle} belongs to another user or needs an administrator. Update from a Tau window on this Mac.`;
    },
    async install(update) {
      const folder = system.mkdtemp(join(dirname(bundle), ".tau-update-"));
      try {
        const unpacked = await system.run("/usr/bin/ditto", ["-x", "-k", update.file, folder], { timeoutMs: 10 * 60_000 });
        if (unpacked.code !== 0) throw new Error(`The download did not unpack: ${lastLine(unpacked.stderr)}`);
        const name = system.list(folder).find((entry) => entry.endsWith(".app"));
        if (!name) throw new Error("The download holds no app.");
        const next = join(folder, name);
        const [id, nextId, nextVersion] = await Promise.all([
          plistValue(system, bundle, "CFBundleIdentifier"),
          plistValue(system, next, "CFBundleIdentifier"),
          plistValue(system, next, "CFBundleShortVersionString"),
        ]);
        if (!id || id !== nextId) throw new Error(`The download is another app (${nextId ?? "no bundle id"}), not ${id ?? "Tau"}.`);
        if (nextVersion !== update.version) throw new Error(`The download is version ${nextVersion ?? "unknown"}, not ${update.version}.`);
        const team = await signingTeam(system, bundle);
        if (team) {
          const verified = await system.run("/usr/bin/codesign", ["--verify", "--deep", "--strict", next], { timeoutMs: 5 * 60_000 });
          if (verified.code !== 0) throw new Error(`The download's signature is not valid: ${lastLine(verified.stderr)}`);
          const nextTeam = await signingTeam(system, next);
          if (nextTeam !== team) throw new Error(`The download is signed by ${nextTeam ?? "nobody"}, not by ${team}.`);
        }
        const previous = join(folder, "previous.app");
        system.rename(bundle, previous);
        try {
          system.rename(next, bundle);
        } catch (error) {
          system.rename(previous, bundle);
          throw error;
        }
        return "restart";
      } finally {
        system.remove(folder);
      }
    },
  };
}

/**
 * Windows: electron-builder's NSIS installer, silently, for this user. It
 * closes every Tau.exe (this host too), so it runs detached and starts the
 * host's task again when it is done.
 */
export function windowsInstaller(system: InstallerSystem, execPath: string, task: string | undefined): UpdateInstaller {
  const folder = dirname(execPath);
  return {
    method: "windows",
    async blocked() {
      return system.writable(folder) ? undefined : `Tau is installed for all users in ${folder}; that needs an administrator. Update from a Tau window on this computer.`;
    },
    async install(update) {
      const quote = (value: string) => `"${value.replaceAll("\"", "")}"`;
      const steps = [`timeout /t 3 /nobreak >nul`, `${quote(update.file)} /S --updated`];
      if (task) steps.push(`schtasks /Run /TN ${quote(task)}`);
      system.spawnDetached("cmd.exe", ["/d", "/s", "/c", `"${steps.join(" & ")}"`], { verbatim: true });
      return "exit";
    },
  };
}

/**
 * For tests and a dev instance (`TAU_UPDATE_FAKE_INSTALL=<file>`): writes what
 * it would install to that file and installs nothing.
 */
export function fakeInstaller(marker: string): UpdateInstaller {
  return {
    method: "deb",
    async blocked() { return undefined; },
    async install(update) {
      writeFileSync(marker, `${JSON.stringify({ version: update.version, channel: update.channel, file: basename(update.file), sha512: update.sha512 })}\n`);
      return "none";
    },
  };
}

export interface HostInstallerInput {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  execPath: string;
  /** The app folder the host runs from: `…/resources/app.asar.unpacked` when installed. */
  appRoot: string;
  /** The service task a Windows installer starts again. */
  windowsTask?: string;
  system?: InstallerSystem;
}

/** The installer of the copy this host runs from, or why there is none. */
export function hostInstaller(input: HostInstallerInput): { installer?: UpdateInstaller; unsupported?: string } {
  const marker = input.env.TAU_UPDATE_FAKE_INSTALL?.trim();
  if (marker) return { installer: fakeInstaller(marker) };
  if (basename(input.appRoot) !== "app.asar.unpacked") {
    return { unsupported: "This Tau runs from a checkout, so it updates with `git pull` and `npm run build`." };
  }
  const system = input.system ?? nodeInstallerSystem();
  const resources = dirname(input.appRoot);
  if (input.platform === "linux") {
    const kind = linuxInstall(input.env, resources, input.execPath, (path) => system.readText(path));
    if (kind === "appimage") return { installer: appImageInstaller(system, input.env.APPIMAGE!) };
    if (kind === "deb") return { installer: debInstaller(system) };
    return { unsupported: UNPACKED_UPDATES };
  }
  if (input.platform === "darwin") {
    const bundle = macBundle(input.execPath);
    return bundle ? { installer: macInstaller(system, bundle) } : { unsupported: "This Tau does not run from an app bundle." };
  }
  if (input.platform === "win32") return { installer: windowsInstaller(system, input.execPath, input.windowsTask) };
  return { unsupported: `Tau does not update itself on ${input.platform}.` };
}

export function nodeInstallerSystem(): InstallerSystem {
  return {
    run: (command, args, options = {}) => new Promise((resolve) => {
      const input = options.stdinFile ? openSync(options.stdinFile, "r") : "ignore";
      const child = spawn(command, [...args], { stdio: [input, "pipe", "pipe"], windowsHide: true });
      if (typeof input === "number") closeSync(input);
      let stdout = "";
      let stderr = "";
      child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { if (stdout.length < 1_000_000) stdout += chunk; });
      child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < 1_000_000) stderr += chunk; });
      const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;
      child.once("error", (error) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: stderr || error.message }); });
      child.once("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    }),
    spawnDetached: (command, args, options = {}) => {
      spawn(command, [...args], { detached: true, stdio: "ignore", windowsHide: true, ...(options.verbatim ? { windowsVerbatimArguments: true } : {}) }).unref();
    },
    exists: existsSync,
    writable: (path) => {
      try { accessSync(path, constants.W_OK); return true; } catch { return false; }
    },
    mkdtemp: (prefix) => mkdtempSync(prefix),
    rename: renameSync,
    copy: copyFileSync,
    chmod: chmodSync,
    remove: (path) => rmSync(path, { recursive: true, force: true }),
    list: (path) => readdirSync(path),
    readText: (path) => {
      try { return readFileSync(path, "utf8"); } catch { return undefined; }
    },
  };
}
