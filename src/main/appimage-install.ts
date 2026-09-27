import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isNightlyVersion } from "../shared/app-version.js";
import { compareVersions } from "../shared/runtime-version.js";
import { DEB_EXECUTABLE, DEB_PACKAGE, NIGHTLY_TAG, type UpdateFeed, type UpdateLog } from "./app-updates.js";

/**
 * On Ubuntu 24.04+ an AppImage runs without Chromium's sandbox: AppRun adds
 * `--no-sandbox` when `unshare -Ur` fails, and no AppArmor profile can name a
 * mount path that changes on every start. The .deb carries a profile for
 * /opt/Tau/tau, so the AppImage offers to install it and restart from there.
 */

/** A message box; the answer is the index of the button chosen. */
export interface InstallPrompt {
  type?: "info" | "warning" | "error" | "question";
  message: string;
  detail: string;
  buttons: string[];
  defaultId?: number;
  cancelId?: number;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** What the offer reads from and does to the machine; tests replace every part. */
export interface InstallSystem {
  exists(path: string): boolean;
  /** Runs a command without a shell; a missing one is code 127 with ENOENT in stderr. */
  run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<CommandResult>;
  /** Starts `command` once the process `pid` has exited. */
  relaunch(pid: number, command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): void;
  remove(path: string): void;
  isRoot: boolean;
}

export interface PackageInstallOptions {
  env: NodeJS.ProcessEnv;
  /** The running Tau's version; the .deb of the same release is installed. */
  version: string;
  arch: string;
  pid: number;
  /** This process's arguments after the executable. */
  argv: readonly string[];
  /** Whether Chromium runs without its sandbox (`--no-sandbox`). */
  noSandbox: boolean;
  /** The build's GitHub feed; the release of `version` holds `latest-linux.yml`. */
  feed?: UpdateFeed;
  /** Holds the decision and the download. */
  folder: string;
  ask(prompt: InstallPrompt, signal?: AbortSignal): Promise<number>;
  copyText(text: string): void;
  fetch(url: string, init?: { signal?: AbortSignal }): Promise<Response>;
  log: UpdateLog;
  system?: InstallSystem;
}

/** electron-builder's names for the architectures Tau could ship a .deb for. */
const DEB_ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };
/** Where the elevated script and the probes look, whatever PATH the AppImage set. */
const SYSTEM_DIRECTORIES = ["/usr/sbin", "/usr/bin", "/sbin", "/bin"];

export interface InstallState {
  /** "Later" was chosen while this version ran. */
  laterVersion?: string;
  /** The AppImage the installed Tau replaced; the installed Tau offers to delete it. */
  replacedAppImage?: string;
}

function readState(folder: string): InstallState {
  try {
    const value = JSON.parse(readFileSync(join(folder, "state.json"), "utf8")) as InstallState;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function writeState(folder: string, state: InstallState): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

/** What AppRun put in front of this process's environment, taken out again for anything started from here. */
export function environmentOutsideAppImage(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  const appDir = env.APPDIR;
  for (const key of ["APPIMAGE", "APPDIR", "ARGV0", "OWD", "APPIMAGE_EXTRACT_AND_RUN"]) delete next[key];
  if (appDir) {
    for (const key of ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS", "GSETTINGS_SCHEMA_DIR"]) {
      const kept = (next[key] ?? "").split(":").filter((entry) => entry && entry !== appDir && !entry.startsWith(`${appDir}/`));
      if (kept.length) next[key] = kept.join(":");
      else delete next[key];
    }
  }
  // Electron swaps the desktop name for its tray and keeps the original here.
  if (next.ORIGINAL_XDG_CURRENT_DESKTOP) {
    next.XDG_CURRENT_DESKTOP = next.ORIGINAL_XDG_CURRENT_DESKTOP;
    delete next.ORIGINAL_XDG_CURRENT_DESKTOP;
  }
  return next;
}

/** The directory of the release this version came from, where its `latest-linux*.yml` lies. */
export function releaseFeedUrl(version: string, feed: UpdateFeed | undefined, env: NodeJS.ProcessEnv): string | undefined {
  // A local feed for tests and containers; nothing may be fetched from the real releases there.
  const override = env.TAU_INSTALL_FEED_URL?.trim();
  if (override) return override.endsWith("/") ? override : `${override}/`;
  if (!feed) return undefined;
  const tag = isNightlyVersion(version) ? NIGHTLY_TAG : `v${version}`;
  return `https://github.com/${feed.owner}/${feed.repo}/releases/download/${tag}/`;
}

/** electron-builder's per-architecture update file. */
export function releaseInfoFile(arch: string): string {
  return arch === "x64" ? "latest-linux.yml" : `latest-linux-${arch}.yml`;
}

export interface ReleaseFile {
  url: string;
  /** Base64, as electron-builder writes it. */
  sha512: string;
  size?: number;
}

/** The `version` and `files` of a `latest-linux.yml`; only the flat shape electron-builder writes. */
export function parseReleaseInfo(text: string): { version?: string; files: ReleaseFile[] } {
  const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/u, "$2");
  const files: ReleaseFile[] = [];
  let version: string | undefined;
  let entry: Partial<ReleaseFile> | undefined;
  let inFiles = false;
  const flush = () => {
    if (entry?.url && entry.sha512) files.push(entry as ReleaseFile);
    entry = undefined;
  };
  for (const line of text.split(/\r?\n/u)) {
    const top = /^([A-Za-z]\w*):\s*(.*)$/u.exec(line);
    if (top) {
      flush();
      inFiles = top[1] === "files";
      if (top[1] === "version") version = unquote(top[2]!);
      continue;
    }
    if (!inFiles) continue;
    const item = /^\s*-\s+(\w+):\s*(.*)$/u.exec(line);
    const field = item ?? /^\s+(\w+):\s*(.*)$/u.exec(line);
    if (!field) continue;
    if (item) {
      flush();
      entry = {};
    }
    if (!entry) continue;
    const [, key, raw] = field;
    if (key === "url") entry.url = unquote(raw!);
    else if (key === "sha512") entry.sha512 = unquote(raw!);
    else if (key === "size" && /^\d+$/u.test(raw!.trim())) entry.size = Number(raw!.trim());
  }
  flush();
  return { ...(version ? { version } : {}), files };
}

/** The .deb of this architecture in a release, with the name it is saved under. */
export function packageFile(info: { files: ReleaseFile[] }, arch: string, base: string): (ReleaseFile & { href: string; name: string }) | undefined {
  const debArch = DEB_ARCH[arch];
  if (!debArch) return undefined;
  const file = info.files.find((candidate) => candidate.url.endsWith(`_${debArch}.deb`));
  if (!file) return undefined;
  const href = new URL(file.url, base).href;
  const name = decodeURIComponent(basename(new URL(href).pathname));
  return /^[\w.+~-]+\.deb$/u.test(name) ? { ...file, href, name } : undefined;
}

export class ChecksumMismatch extends Error {}

async function fileSha512(path: string): Promise<string> {
  const hash = createHash("sha512");
  await pipeline(createReadStream(path), hash);
  return hash.digest("base64");
}

/**
 * Downloads `url` to `target` and keeps it only when size and SHA-512 match
 * the release; a file already there that matches is kept as it is.
 */
export async function downloadVerified(
  fetchUrl: PackageInstallOptions["fetch"],
  url: string,
  target: string,
  expected: { sha512: string; size?: number },
  signal?: AbortSignal,
): Promise<void> {
  if (existsSync(target) && await fileSha512(target) === expected.sha512) return;
  const response = await fetchUrl(url, signal ? { signal } : {});
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}.`);
  const partial = `${target}.part`;
  const hash = createHash("sha512");
  let size = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as never), count, createWriteStream(partial), signal ? { signal } : {});
    const digest = hash.digest("base64");
    if (digest !== expected.sha512 || (expected.size !== undefined && size !== expected.size)) {
      throw new ChecksumMismatch(`The download of ${basename(target)} does not match the release's checksum; nothing was installed.`);
    }
    renameSync(partial, target);
  } finally {
    rmSync(partial, { force: true });
  }
}

/**
 * Runs as root: copies the package where the user cannot change it, checks it
 * against the release's SHA-512 again and installs it with its dependencies.
 */
const INSTALL_PACKAGE = [
  "set -e",
  `PATH=${SYSTEM_DIRECTORIES.join(":")}`,
  "dir=$(mktemp -d)",
  "trap 'rm -rf \"$dir\"' EXIT",
  "chmod 0755 \"$dir\"",
  "install -m 0644 \"$1\" \"$dir/tau.deb\"",
  "printf '%s  %s\\n' \"$2\" \"$dir/tau.deb\" | sha512sum --check --status || { echo 'The package does not match its checksum.' >&2; exit 1; }",
  "DEBIAN_FRONTEND=noninteractive apt-get install -y -o DPkg::Lock::Timeout=120 \"$dir/tau.deb\"",
].join("\n");

/** The one pkexec call that installs the downloaded package. */
export function installCommand(debPath: string, sha512: string): { command: string; args: string[] } {
  const hex = Buffer.from(sha512, "base64").toString("hex");
  // pkexec's own text agent would ask on a terminal Tau does not have.
  return { command: "pkexec", args: ["--disable-internal-agent", "/bin/sh", "-c", INSTALL_PACKAGE, "sh", debPath, hex] };
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/** What someone types where no password dialog can open. */
export function terminalCommand(debPath: string): string {
  return `sudo apt install ${shellQuote(debPath)}`;
}

/** Why pkexec did not install, and whether the terminal is the way left. */
export function installFailure(result: CommandResult): { reason: string; terminal: boolean } {
  const detail = (result.stderr.trim().split("\n").filter(Boolean).at(-1) ?? "").replace(/\.$/u, "");
  if (/ENOENT/u.test(result.stderr)) return { reason: "pkexec is not installed, so no password dialog can open.", terminal: true };
  if (result.code === 126) return { reason: "The password dialog was closed; nothing was installed.", terminal: false };
  if (/authentication agent|authority/iu.test(result.stderr)) {
    return { reason: "No password dialog could open: pkexec needs a polkit agent, which a desktop session has and an SSH login does not.", terminal: true };
  }
  return { reason: `Installing failed (exit ${result.code})${detail ? `: ${detail}` : ""}.`, terminal: true };
}

function findSystemCommand(system: InstallSystem, name: string): string | undefined {
  return SYSTEM_DIRECTORIES.map((directory) => `${directory}/${name}`).find((path) => system.exists(path));
}

/** The version of the installed package, if dpkg has it installed. */
async function installedVersion(system: InstallSystem, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const dpkgQuery = findSystemCommand(system, "dpkg-query");
  if (!dpkgQuery || !system.exists(DEB_EXECUTABLE)) return undefined;
  const result = await system.run(dpkgQuery, ["-W", "-f=${db:Status-Status} ${Version}", DEB_PACKAGE], env);
  const match = /^installed (\S+)/u.exec(result.stdout.trim());
  return result.code === 0 ? match?.[1] : undefined;
}

export interface Situation {
  /** The installed package, when one at least as new as this AppImage is there already. */
  installed?: string;
}

/**
 * Whether this is an AppImage without Chromium's sandbox because the machine
 * refuses it user namespaces, on a system that installs .deb packages.
 */
export async function appImageSituation(options: Pick<PackageInstallOptions, "env" | "noSandbox" | "arch" | "version">, system: InstallSystem): Promise<Situation | undefined> {
  if (!options.env.APPIMAGE || !options.noSandbox || system.isRoot || !DEB_ARCH[options.arch]) return undefined;
  if (!findSystemCommand(system, "dpkg") || !findSystemCommand(system, "apt-get")) return undefined;
  const env = environmentOutsideAppImage(options.env);
  // AppRun's own probe: a `--no-sandbox` given by hand on a machine that allows namespaces is the user's choice.
  const unshare = findSystemCommand(system, "unshare");
  if (unshare && (await system.run(unshare, ["-Ur", "true"], env)).code === 0) return undefined;
  const installed = await installedVersion(system, env);
  return installed && compareVersions(installed, options.version) >= 0 ? { installed } : {};
}

const WHY = "It runs without Chromium's sandbox: Ubuntu allows the sandbox only to installed apps, and the sandbox is what keeps web pages in the preview away from your files and the rest of the machine.";

/**
 * Offers the .deb to an AppImage without sandbox, and the installed Tau the
 * deletion of the AppImage it replaced. True when Tau is restarting from
 * /opt/Tau: the caller exits and starts nothing.
 */
export async function offerPackageInstall(options: PackageInstallOptions): Promise<boolean> {
  const system = options.system ?? nodeInstallSystem();
  const state = readState(options.folder);
  if (!options.env.APPIMAGE) {
    await offerAppImageRemoval(options, system, state);
    return false;
  }
  if (state.laterVersion === options.version) return false;
  const situation = await appImageSituation(options, system);
  if (!situation) return false;
  options.log.info("package-install.offer", situation);
  const later = () => writeState(options.folder, { ...state, laterVersion: options.version });

  if (situation.installed) {
    const answer = await options.ask({
      type: "question",
      message: "Use the installed Tau (recommended)",
      detail: `Tau ${situation.installed} is installed in /opt/Tau, but this is the AppImage. ${WHY}\n\nTau restarts from /opt/Tau. Your threads and settings stay.`,
      buttons: ["Restart from /opt/Tau", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (answer !== 0) {
      later();
      return false;
    }
    return relaunchInstalled(options, system, state);
  }

  const answer = await options.ask({
    type: "question",
    message: "Install Tau properly (recommended)",
    detail: `This AppImage of Tau ${options.version} is not installed. ${WHY}\n\nTau downloads its .deb, asks for your password once and restarts from /opt/Tau. Your threads and settings stay.`,
    buttons: ["Install Tau", "Later"],
    defaultId: 0,
    cancelId: 1,
  });
  if (answer !== 0) {
    later();
    return false;
  }

  const downloaded = await download(options);
  if (!downloaded) return false;
  const debPath = downloaded.path;
  const { command, args } = installCommand(debPath, downloaded.sha512);
  options.log.info("package-install.installing", debPath);
  const result = await system.run(command, args, environmentOutsideAppImage(options.env));
  if (result.code !== 0 || !system.exists(DEB_EXECUTABLE)) {
    const failure = result.code === 0 ? { reason: `The package installed, but ${DEB_EXECUTABLE} is missing.`, terminal: false } : installFailure(result);
    options.log.warn("package-install.failed", { code: result.code, stderr: result.stderr.slice(-2000) });
    await tellFailure(options, failure, debPath);
    return false;
  }
  rmSync(debPath, { force: true });
  return relaunchInstalled(options, system, state);
}

/** Downloads the release's .deb behind a box that can cancel it; undefined when it did not arrive. */
async function download(options: PackageInstallOptions): Promise<{ path: string; sha512: string } | undefined> {
  const tell = (detail: string) => options.ask({ type: "error", message: "Tau was not installed", detail: `${detail}\n\nTau asks again at its next start.`, buttons: ["OK"] });
  const base = releaseFeedUrl(options.version, options.feed, options.env);
  if (!base) {
    await tell("This build names no release to download from.");
    return undefined;
  }
  const controller = new AbortController();
  const done = new AbortController();
  const box = options.ask({
    type: "info",
    message: `Downloading Tau ${options.version}…`,
    detail: "The password dialog follows once the .deb is here.",
    buttons: ["Cancel"],
    cancelId: 0,
  }, done.signal).then(() => { if (!done.signal.aborted) controller.abort(); });
  try {
    const infoUrl = new URL(releaseInfoFile(options.arch), base).href;
    const response = await options.fetch(infoUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`${infoUrl} answered ${response.status}.`);
    const file = packageFile(parseReleaseInfo(await response.text()), options.arch, base);
    if (!file) throw new Error(`The release lists no .deb for ${options.arch}.`);
    mkdirSync(options.folder, { recursive: true });
    const target = join(options.folder, file.name);
    await downloadVerified(options.fetch, file.href, target, file, controller.signal);
    return { path: target, sha512: file.sha512 };
  } catch (error: unknown) {
    const cancelled = controller.signal.aborted;
    options.log.warn("package-install.download.failed", error);
    done.abort();
    await box;
    if (!cancelled) await tell(error instanceof ChecksumMismatch ? error.message : `The download failed: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  } finally {
    done.abort();
  }
}

async function tellFailure(options: PackageInstallOptions, failure: { reason: string; terminal: boolean }, debPath: string): Promise<void> {
  if (!failure.terminal) {
    await options.ask({ type: "warning", message: "Tau was not installed", detail: `${failure.reason}\n\nTau asks again at its next start.`, buttons: ["OK"] });
    return;
  }
  const command = terminalCommand(debPath);
  const answer = await options.ask({
    type: "warning",
    message: "Install Tau in a terminal",
    detail: `${failure.reason}\n\nThe .deb is downloaded and checked. In a terminal on this machine, run:\n\n${command}\n\nThen start Tau again; it restarts from /opt/Tau.`,
    buttons: ["Copy Command", "OK"],
    defaultId: 0,
    cancelId: 1,
  });
  if (answer === 0) options.copyText(command);
}

function relaunchInstalled(options: PackageInstallOptions, system: InstallSystem, state: InstallState): true {
  writeState(options.folder, { ...state, replacedAppImage: options.env.APPIMAGE! });
  // Never `--no-sandbox`: that is what AppRun added and what the package makes unneeded.
  const args = options.argv.filter((arg) => arg !== "--no-sandbox");
  const cwd = options.env.OWD && system.exists(options.env.OWD) ? options.env.OWD : homedir();
  options.log.info("package-install.relaunch", DEB_EXECUTABLE);
  system.relaunch(options.pid, DEB_EXECUTABLE, args, environmentOutsideAppImage(options.env), cwd);
  return true;
}

/** In the installed Tau, once: the AppImage it replaced may go. */
async function offerAppImageRemoval(options: PackageInstallOptions, system: InstallSystem, state: InstallState): Promise<void> {
  const appImage = state.replacedAppImage;
  if (!appImage) return;
  const { replacedAppImage: _handled, ...rest } = state;
  writeState(options.folder, rest);
  if (!system.exists(appImage)) return;
  const answer = await options.ask({
    type: "question",
    message: "Tau is installed",
    detail: `Tau now runs from /opt/Tau with Chromium's sandbox and updates itself there. The AppImage it was started from is no longer needed:\n\n${appImage}`,
    buttons: ["Delete the AppImage", "Keep It"],
    defaultId: 0,
    cancelId: 1,
  });
  if (answer !== 0) return;
  try {
    system.remove(appImage);
    options.log.info("package-install.appimage.removed", appImage);
  } catch (error: unknown) {
    await options.ask({ type: "warning", message: "The AppImage was not deleted", detail: error instanceof Error ? error.message : String(error), buttons: ["OK"] });
  }
}

/** Waits for the old process to exit, so the new one gets the single-instance lock. */
const AFTER_EXIT = "while kill -0 \"$0\" 2>/dev/null; do sleep 0.2; done; exec \"$@\"";

export function nodeInstallSystem(): InstallSystem {
  return {
    exists: existsSync,
    run: (command, args, env) => new Promise((resolve) => {
      // A password dialog waits for the user; no limit short of a quarter hour.
      execFile(command, [...args], { env, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 127) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error && code === 127 ? error.message : "") });
      });
    }),
    relaunch: (pid, command, args, env, cwd) => {
      spawn("/bin/sh", ["-c", AFTER_EXIT, String(pid), command, ...args], { env, cwd, detached: true, stdio: "ignore" }).unref();
    },
    remove: unlinkSync,
    isRoot: process.getuid?.() === 0,
  };
}
