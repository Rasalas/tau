import { realpath as fsRealpath, stat } from "node:fs/promises";
import { compareVersions } from "../shared/runtime-version.js";
import { commandLine } from "../shared/sign-in.js";
import { homebrewLatestVersion, npmLatestVersion, type HomebrewKind } from "./cli-versions.js";

/**
 * How a CLI a runtime drives got onto the machine, and the command that
 * updates that install. Every command names only the package names a kit
 * declared (`CliPackageSpec`) and is an argument list, never a shell line.
 */

/** What a kit knows about the program it drives. */
export interface CliPackageSpec {
  /** The npm package that ships the CLI. */
  npm?: string;
  /** Homebrew formulae and casks that install it; a keg of any other name is left alone. */
  homebrew?: { formulae?: readonly string[]; casks?: readonly string[] };
  /** The CLI's own updater, for an install whose path contains one of `paths` (`/.local/share/<tool>/`). */
  native?: { args: readonly string[]; paths: readonly string[] };
}

export type CliInstallMethod = "homebrew-formula" | "homebrew-cask" | "npm" | "pnpm" | "bun" | "native" | "unknown";

/** A program and its arguments; run with `execFile`, shown with `cliCommandText`. */
export interface CliCommand {
  executable: string;
  args: readonly string[];
}

export interface CliInstall {
  method: CliInstallMethod;
  /** For people: "Homebrew cask codex", "npm in ~/.local". */
  label: string;
  /** The executable as found and its resolved target. */
  path: string;
  realPath: string;
  /** The formula, cask or npm package the install is. */
  name?: string;
  /** npm's global prefix, or the Homebrew prefix. */
  prefix?: string;
  /** What updates this install; absent when Tau cannot prove who owns it. */
  update?: CliCommand;
  /** Why there is no `update`. */
  note?: string;
}

export interface DetectCliInstallOptions {
  /** `services.findCommand`: npm, brew, pnpm and bun are the ones on the user's PATH. */
  findCommand(name: string): string | undefined;
  realpath?(path: string): Promise<string>;
  platform?: NodeJS.Platform;
  /** Shortens paths in labels. */
  home?: string;
}

const slash = (path: string) => path.replaceAll("\\", "/");

function shortPath(path: string, home: string | undefined): string {
  return home && path.startsWith(`${slash(home)}/`) ? `~${path.slice(slash(home).length)}` : path;
}

/**
 * The npm prefix that owns `packageName` at this resolved path:
 * `<prefix>/lib/node_modules/<pkg>/…` (POSIX) or `<prefix>/node_modules/<pkg>/…`
 * (Windows). A project's own `node_modules` further up is not a global install.
 */
export function npmGlobalPrefix(realPath: string, packageName: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const path = slash(realPath);
  const lower = path.toLowerCase();
  const segment = `${platform === "win32" ? "" : "/lib"}/node_modules/${packageName.toLowerCase()}/`;
  const index = lower.lastIndexOf(segment);
  if (index <= 0 || lower.slice(0, index).includes("/node_modules/")) return undefined;
  return path.slice(0, index);
}

/** `<prefix>/Cellar/<name>/<version>/…` or `<prefix>/Caskroom/<name>/<version>/…`. */
export function homebrewKeg(realPath: string): { kind: HomebrewKind; name: string; prefix: string } | undefined {
  const match = /^(.*)\/(cellar|caskroom)\/([^/]+)\/[^/]+\//iu.exec(slash(realPath));
  if (!match) return undefined;
  return { kind: match[2]!.toLowerCase() === "cellar" ? "formula" : "cask", name: match[3]!, prefix: match[1]! };
}

/**
 * Who owns the executable at `path`. A package manager counts only with
 * proof: its package segment in the resolved path for npm, pnpm and bun (so a
 * global under a Homebrew-installed Node is npm's, not brew's), a keg Homebrew
 * names and a `brew` under the same prefix for Homebrew, a path the kit names
 * for the CLI's own updater. Everything else is `unknown` and has no update.
 */
export async function detectCliInstall(path: string, spec: CliPackageSpec, options: DetectCliInstallOptions): Promise<CliInstall> {
  const resolve = options.realpath ?? ((target: string) => fsRealpath(target));
  const platform = options.platform ?? process.platform;
  const realPath = slash(await resolve(path).catch(() => path));
  const paths = [slash(path).toLowerCase(), realPath.toLowerCase()];
  const base = { path, realPath };
  const found = (name: string) => options.findCommand(name);

  if (spec.native && spec.native.paths.some((fragment) => paths.some((candidate) => candidate.includes(fragment.toLowerCase())))) {
    return { ...base, method: "native", label: "its own installer", update: { executable: path, args: [...spec.native.args] } };
  }
  const npm = spec.npm;
  const owns = npm ? paths.some((candidate) => candidate.includes(`/node_modules/${npm.toLowerCase()}/`)) : false;
  if (npm && owns && paths.some((candidate) => candidate.includes("/.bun/"))) {
    const bun = found("bun");
    return { ...base, method: "bun", label: "bun", name: npm, ...(bun ? { update: { executable: bun, args: ["add", "-g", `${npm}@latest`] } } : { note: "bun is not on the PATH." }) };
  }
  if (npm && owns && paths.some((candidate) => candidate.includes("/pnpm/"))) {
    const pnpm = found("pnpm");
    return { ...base, method: "pnpm", label: "pnpm", name: npm, ...(pnpm ? { update: { executable: pnpm, args: ["add", "-g", `${npm}@latest`] } } : { note: "pnpm is not on the PATH." }) };
  }
  const prefix = npm ? npmGlobalPrefix(realPath, npm, platform) : undefined;
  if (npm && prefix) {
    const npmPath = found("npm");
    const label = `npm in ${shortPath(prefix, options.home)}`;
    // --prefix keeps the install where it is, whichever Node's npm is first on the PATH.
    return npmPath
      ? { ...base, method: "npm", label, name: npm, prefix, update: { executable: npmPath, args: ["install", "-g", "--prefix", prefix, `${npm}@latest`] } }
      : { ...base, method: "npm", label, name: npm, prefix, note: "npm is not on the PATH." };
  }
  const keg = homebrewKeg(realPath);
  if (keg) {
    const method = keg.kind === "cask" ? "homebrew-cask" : "homebrew-formula";
    const label = `Homebrew ${keg.kind} ${keg.name}`;
    const known = keg.kind === "cask" ? spec.homebrew?.casks : spec.homebrew?.formulae;
    if (!known?.includes(keg.name)) return { ...base, method, label, name: keg.name, prefix: keg.prefix, note: `Tau does not know the Homebrew ${keg.kind} ${keg.name}.` };
    const brew = found("brew");
    const brewReal = brew ? slash(await resolve(brew).catch(() => brew)) : undefined;
    // Only the brew of the prefix the keg lies under may upgrade it.
    if (!brew || !brewReal?.toLowerCase().startsWith(`${keg.prefix.toLowerCase()}/`)) {
      return { ...base, method, label, name: keg.name, prefix: keg.prefix, note: `No brew of ${keg.prefix} is on the PATH.` };
    }
    return { ...base, method, label, name: keg.name, prefix: keg.prefix, update: { executable: brew, args: keg.kind === "cask" ? ["upgrade", "--cask", keg.name] : ["upgrade", keg.name] } };
  }
  return { ...base, method: "unknown", label: "unknown", note: "Tau cannot tell what installed it." };
}

/** The command as a person would type it: `brew upgrade --cask codex`. */
export function cliCommandText(command: CliCommand, platform: string = process.platform): string {
  const name = command.executable.split(/[\\/]/u).pop() ?? command.executable;
  const short = /^(brew|npm|pnpm|bun)(\.cmd|\.exe)?$/iu.test(name) ? name.replace(/\.(cmd|exe)$/iu, "") : command.executable;
  return commandLine(short, command.args, {}, platform === "win32" ? "win32" : "posix");
}

/**
 * What changes when the program is replaced: its resolved path, size and
 * modification time. A catalog or probe cached under another fingerprint is
 * stale. `undefined` when the file is gone.
 */
export async function executableFingerprint(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    const real = await fsRealpath(path);
    const info = await stat(real);
    return `${real}:${info.size}:${Math.round(info.mtimeMs)}`;
  } catch {
    return undefined;
  }
}

/**
 * What a runtime backend tells the host about keeping its program current
 * (`HostRuntimeBackendProvider.maintenance`): how it is installed, the newest
 * release the install's own source has, and the commands for it.
 */
export interface RuntimeToolMaintenance {
  /** The program as the user knows it: `codex`. */
  tool: string;
  installed?: string;
  /** The newest release `update` installs. */
  latest?: string;
  install: Pick<CliInstall, "method" | "label" | "path" | "realPath" | "note">;
  /** Brings `installed` to `latest`; absent when Tau cannot update this install. */
  update?: CliCommand;
  /** Added to the host's environment for the commands (an instance's own home). */
  env?: Record<string, string>;
  /** The install's source lags another one: "Homebrew has 0.159.0, npm 0.159.1". */
  behind?: { source: "homebrew"; latest: string; newer: { source: "npm"; latest: string } };
  /** Moves the install to the source that is ahead: run in order, `restore` when one fails. */
  switch?: { steps: readonly CliCommand[]; restore: readonly CliCommand[] };
}

export interface CliMaintenanceOptions {
  tool: string;
  path: string;
  installed?: string;
  spec: CliPackageSpec;
  findCommand(name: string): string | undefined;
  /** Where the newest versions are cached (`latest-version.json` in the kit's state folder). */
  cacheFile: string;
  env?: NodeJS.ProcessEnv;
  /** The instance's own additions to the environment. */
  commandEnv?: Record<string, string>;
  /** The newest release where npm does not say (a CLI with its own channel); a keg still asks Homebrew. */
  latest?: string;
  fetch?: typeof globalThis.fetch;
  realpath?(path: string): Promise<string>;
  platform?: NodeJS.Platform;
  home?: string;
}

/**
 * `maintenance` for a CLI a kit describes with a `CliPackageSpec`: the
 * install, the newest release of its own source (Homebrew's for a keg, npm's
 * otherwise), and, when Homebrew lags npm, the switch to npm.
 */
export async function cliMaintenance(options: CliMaintenanceOptions): Promise<RuntimeToolMaintenance> {
  const install = await detectCliInstall(options.path, options.spec, {
    findCommand: options.findCommand,
    ...(options.realpath ? { realpath: options.realpath } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.home ? { home: options.home } : {}),
  });
  const latestOptions = { cacheFile: options.cacheFile, ...(options.env ? { env: options.env } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) };
  const npm = options.spec.npm;
  const npmLatest = npm ? await npmLatestVersion(npm, latestOptions) : undefined;
  const homebrew = install.method === "homebrew-cask" || install.method === "homebrew-formula";
  const kind: HomebrewKind = install.method === "homebrew-cask" ? "cask" : "formula";
  // Only a keg the kit named is Homebrew's to ask about.
  const named = (kind === "cask" ? options.spec.homebrew?.casks : options.spec.homebrew?.formulae)?.includes(install.name ?? "") === true;
  const brewLatest = homebrew && named && install.name ? await homebrewLatestVersion(kind, install.name, latestOptions) : undefined;
  const latest = homebrew ? brewLatest : options.latest ?? npmLatest;
  const { method, label, path, realPath, note } = install;
  const answer: RuntimeToolMaintenance = {
    tool: options.tool,
    ...(options.installed ? { installed: options.installed } : {}),
    ...(latest ? { latest } : {}),
    install: { method, label, path, realPath, ...(note ? { note } : {}) },
    ...(install.update ? { update: install.update } : {}),
    ...(options.commandEnv && Object.keys(options.commandEnv).length ? { env: options.commandEnv } : {}),
  };
  if (!homebrew || !brewLatest || !npmLatest || compareVersions(brewLatest, npmLatest) >= 0) return answer;
  answer.behind = { source: "homebrew", latest: brewLatest, newer: { source: "npm", latest: npmLatest } };
  const brew = install.update?.executable;
  const npmPath = options.findCommand("npm");
  if (brew && npmPath && npm && install.name) {
    const flag = kind === "cask" ? ["--cask"] : [];
    // Homebrew goes first: its link and npm's would claim the same name in a shared bin folder.
    answer.switch = {
      steps: [{ executable: brew, args: ["uninstall", ...flag, install.name] }, { executable: npmPath, args: ["install", "-g", `${npm}@latest`] }],
      restore: [{ executable: brew, args: ["install", ...flag, install.name] }],
    };
  }
  return answer;
}
