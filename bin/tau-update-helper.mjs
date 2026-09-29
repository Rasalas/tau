// The .deb's update helper (K103). It runs as root through pkexec, which
// polkit allows without a password to the machine's administrators, and it
// does one thing: install the Tau package it reads on standard input, and only
// if that package is the release of this project it claims to be.
//
//   pkexec /opt/Tau/bin/tau-update-helper install --version <x.y.z> [--channel stable|nightly] < Tau_x.y.z_amd64.deb
//
// It takes no path and no URL. Where the release lives comes from the app's
// own `resources/app-update.yml` (root's, installed by dpkg), or from
// /etc/tau/update-helper.json, which only root can write. It fetches the
// release's `latest-linux*.yml` itself and checks the package against it:
// size, SHA-512, and the release key's signature once this file carries a key.
// The package must be `tau`, for this architecture, exactly the version asked
// for, and newer than the one installed. Plain Node, no dependencies.
import { spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Must equal RELEASE_PUBLIC_KEYS in src/shared/release-keys.ts; a test checks. */
export const RELEASE_PUBLIC_KEYS = [];
export const PACKAGE = "tau";
export const APP_UPDATE_FILE = "/opt/Tau/resources/app-update.yml";
export const ADMIN_CONFIG = "/etc/tau/update-helper.json";
/** No Tau package is near this; a stream beyond it is not one. */
const MAX_BYTES = 1024 ** 3;
const SYSTEM_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";

export const EXIT = { usage: 64, refused: 65, notNewer: 66, feed: 69, install: 70, notRoot: 77 };

export class HelperError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-nightly\.\d{8}\.\d{1,9})?$/u;

/** `install --version <v> [--channel stable|nightly]`, nothing else. */
export function parseArgs(argv) {
  const [action, ...rest] = argv;
  if (action !== "install") throw new HelperError(EXIT.usage, "usage: tau-update-helper install --version <x.y.z> [--channel stable|nightly] < package.deb");
  let version;
  let channel = "stable";
  for (let index = 0; index < rest.length; index += 2) {
    const [flag, value] = [rest[index], rest[index + 1]];
    if (flag === "--version" && version === undefined && typeof value === "string" && VERSION.test(value)) version = value;
    else if (flag === "--channel" && (value === "stable" || value === "nightly")) channel = value;
    else throw new HelperError(EXIT.usage, `tau-update-helper: ${flag ?? "an argument"} is not one it takes.`);
  }
  if (!version) throw new HelperError(EXIT.usage, "tau-update-helper: --version <x.y.z> is required.");
  if ((channel === "nightly") !== version.includes("-nightly.")) throw new HelperError(EXIT.usage, `tau-update-helper: ${version} is not a ${channel} version.`);
  return { version, channel };
}

/** electron-builder writes a deb's version with `~` where the app's has `-`. */
export const debVersion = (version) => version.replaceAll("-", "~");

/** Semver order, prerelease before release; a deb's `~` reads as `-`. */
export function compareVersions(left, right) {
  const parts = (value) => {
    const match = /^(\d+(?:\.\d+)*)(?:[-~]([0-9A-Za-z.-]+))?$/u.exec(String(value).trim());
    return match ? { numbers: match[1].split(".").map(Number), pre: match[2] } : undefined;
  };
  const a = parts(left);
  const b = parts(right);
  if (!a || !b) return Number.NaN;
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.pre && !b.pre) return -1;
  if (!a.pre && b.pre) return 1;
  if (a.pre && b.pre) return a.pre.localeCompare(b.pre, "en", { numeric: true });
  return 0;
}

/** The GitHub repository `publish:` names in the app's `app-update.yml`. */
export function readFeed(text) {
  const value = (key) => new RegExp(`^${key}:\\s*['"]?([^'"\\s#]+)`, "mu").exec(text)?.[1];
  const owner = value("owner");
  const repo = value("repo");
  if (value("provider") !== "github" || !owner || !repo || !/^[\w.-]+$/u.test(owner) || !/^[\w.-]+$/u.test(repo)) return undefined;
  return { owner, repo };
}

/** The release folder of exactly this version: its tag, or the moving nightly one. */
export function releaseBase(config, version, channel) {
  if (config.feedUrl) return config.feedUrl.endsWith("/") ? config.feedUrl : `${config.feedUrl}/`;
  const tag = channel === "nightly" ? "nightly" : `v${version}`;
  return `https://github.com/${config.owner}/${config.repo}/releases/download/${tag}/`;
}

/** The flat `version` and `files` electron-builder writes. */
export function parseReleaseInfo(text) {
  const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/u, "$2");
  const files = [];
  let version;
  let entry;
  let inFiles = false;
  const flush = () => { if (entry?.url && entry.sha512) files.push(entry); entry = undefined; };
  for (const line of text.split(/\r?\n/u)) {
    const top = /^([A-Za-z]\w*):\s*(.*)$/u.exec(line);
    if (top) {
      flush();
      inFiles = top[1] === "files";
      if (top[1] === "version") version = unquote(top[2]);
      continue;
    }
    if (!inFiles) continue;
    const item = /^\s*-\s+(\w+):\s*(.*)$/u.exec(line);
    const field = item ?? /^\s+(\w+):\s*(.*)$/u.exec(line);
    if (!field) continue;
    if (item) { flush(); entry = {}; }
    if (!entry) continue;
    const [, key, raw] = field;
    if (key === "url") entry.url = unquote(raw);
    else if (key === "sha512") entry.sha512 = unquote(raw);
    else if (key === "size" && /^\d+$/u.test(raw.trim())) entry.size = Number(raw.trim());
  }
  flush();
  return { version, files };
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** One base64 signature per line; any line by any listed key will do (verifyReleaseSignature in release-feed.ts). */
export function verifySignature(text, signature, keys) {
  const signatures = String(signature).split(/\s+/u).filter(Boolean).map((line) => Buffer.from(line, "base64")).filter((bytes) => bytes.length === 64);
  return signatures.some((bytes) => keys.some((key) => {
    try {
      const publicKey = key.includes("-----BEGIN")
        ? createPublicKey({ key, format: "pem" })
        : createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(key, "base64")]), format: "der", type: "spki" });
      return verify(null, Buffer.from(text, "utf8"), publicKey, bytes);
    } catch {
      return false;
    }
  }));
}

const DEB_TO_INFO = { amd64: "latest-linux.yml", arm64: "latest-linux-arm64.yml" };

/** Everything that decides whether a package may be installed; the machine's parts come from `system`. */
export async function installUpdate({ argv, system, keys = RELEASE_PUBLIC_KEYS }) {
  const { version, channel } = parseArgs(argv);
  if (!system.isRoot()) throw new HelperError(EXIT.notRoot, "tau-update-helper runs as root, through pkexec.");
  const config = system.config();
  if (!config) throw new HelperError(EXIT.feed, `tau-update-helper: ${APP_UPDATE_FILE} names no GitHub release feed.`);
  const debArch = (await system.run("dpkg", ["--print-architecture"])).stdout.trim();
  const infoName = DEB_TO_INFO[debArch];
  if (!infoName) throw new HelperError(EXIT.refused, `tau-update-helper: Tau ships no package for ${debArch || "this architecture"}.`);
  const installed = await system.run("dpkg-query", ["-W", "-f=${Version}", PACKAGE]);
  if (installed.code !== 0 || !installed.stdout.trim()) throw new HelperError(EXIT.refused, "tau-update-helper: the tau package is not installed; it only updates it.");
  if (!(compareVersions(version, installed.stdout.trim()) > 0)) {
    throw new HelperError(EXIT.notNewer, `tau-update-helper: ${version} is not newer than the installed ${installed.stdout.trim()}; it never goes back.`);
  }

  const base = releaseBase(config, version, channel);
  const infoUrl = new URL(infoName, base).href;
  const response = await system.fetch(infoUrl).catch((error) => { throw new HelperError(EXIT.feed, `tau-update-helper: ${infoUrl} did not answer: ${error.message}`); });
  if (!response.ok) throw new HelperError(EXIT.feed, `tau-update-helper: ${infoUrl} answered ${response.status}.`);
  const text = await response.text();
  if (keys.length > 0) {
    const signature = await system.fetch(`${infoUrl}.sig`).catch(() => undefined);
    if (!signature?.ok || !verifySignature(text, await signature.text(), keys)) {
      throw new HelperError(EXIT.refused, `tau-update-helper: ${infoName} is not signed by Tau's release key.`);
    }
  }
  const info = parseReleaseInfo(text);
  if (info.version !== version) throw new HelperError(EXIT.refused, `tau-update-helper: the release names ${info.version ?? "no version"}, not ${version}.`);
  const file = info.files.find((entry) => entry.url === `Tau_${version}_${debArch}.deb` || entry.url.endsWith(`/Tau_${version}_${debArch}.deb`));
  if (!file) throw new HelperError(EXIT.refused, `tau-update-helper: the release lists no package for ${debArch}.`);

  const folder = system.tempFolder();
  try {
    const target = join(folder, "tau.deb");
    const received = await system.receive(target, Math.min(file.size ?? MAX_BYTES, MAX_BYTES));
    if (received.sha512 !== file.sha512 || (file.size !== undefined && received.size !== file.size)) {
      throw new HelperError(EXIT.refused, "tau-update-helper: the package does not match the release's checksum; nothing was installed.");
    }
    const fields = await system.run("dpkg-deb", ["--field", target, "Package", "Version", "Architecture"]);
    const field = (name) => new RegExp(`^${name}:\\s*(\\S+)$`, "mu").exec(fields.stdout)?.[1];
    if (fields.code !== 0 || field("Package") !== PACKAGE || field("Architecture") !== debArch || field("Version") !== debVersion(version)) {
      throw new HelperError(EXIT.refused, `tau-update-helper: the file is not tau ${debVersion(version)} for ${debArch}.`);
    }
    const apt = await system.run("apt-get", ["install", "-y", "--no-install-recommends", "-o", "DPkg::Lock::Timeout=120", target], { DEBIAN_FRONTEND: "noninteractive" });
    if (apt.code !== 0) {
      const detail = apt.stderr.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${apt.code}`;
      throw new HelperError(EXIT.install, `tau-update-helper: apt-get did not install it: ${detail}`);
    }
    return { version, installed: installed.stdout.trim() };
  } finally {
    system.removeFolder(folder);
  }
}

/** Where the release lives: the app's own feed, or an administrator's mirror. */
function machineConfig() {
  let feed;
  try { feed = readFeed(readFileSync(APP_UPDATE_FILE, "utf8")); } catch { feed = undefined; }
  let admin;
  try { admin = JSON.parse(readFileSync(ADMIN_CONFIG, "utf8")); } catch { admin = undefined; }
  const feedUrl = typeof admin?.feedUrl === "string" && /^https?:\/\/\S+$/u.test(admin.feedUrl) ? admin.feedUrl : undefined;
  if (feedUrl) return { feedUrl };
  return feed;
}

function run(command, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: SYSTEM_PATH, LANG: "C", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.once("error", (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Standard input into a root-only file, hashed on the way, never more than `limit` bytes. */
function receive(target, limit) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    const out = createWriteStream(target, { mode: 0o600 });
    let size = 0;
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        process.stdin.destroy();
        out.destroy();
        reject(new HelperError(EXIT.refused, "tau-update-helper: the input is larger than the release's package."));
        return;
      }
      hash.update(chunk);
      out.write(chunk);
    });
    process.stdin.once("error", reject);
    process.stdin.once("end", () => out.end(() => resolve({ size, sha512: hash.digest("base64") })));
  });
}

export function nodeSystem() {
  return {
    isRoot: () => process.getuid?.() === 0,
    config: machineConfig,
    run,
    fetch: (url) => fetch(url, { redirect: "follow" }),
    tempFolder: () => mkdtempSync(join(tmpdir(), "tau-update-")),
    removeFolder: (folder) => rmSync(folder, { recursive: true, force: true }),
    receive,
  };
}

export async function main(argv = process.argv.slice(2), system = nodeSystem()) {
  try {
    const result = await installUpdate({ argv, system });
    process.stdout.write(`tau-update-helper: installed Tau ${result.version} over ${result.installed}.\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof HelperError ? error.code : EXIT.install;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then((code) => { process.exitCode = code; });
}
