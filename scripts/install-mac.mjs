#!/usr/bin/env node
// Installs a released Tau on this Mac: downloads the .dmg that matches this
// machine's architecture from the public release repository, copies Tau.app
// into /Applications, and strips the quarantine attribute Gatekeeper would
// otherwise block an unsigned app on. The download needs no login: the
// release's latest-mac.yml must carry Tau's release signature, and the .dmg
// must match the SHA-512 it lists. A tag that only the private source
// repository has falls back to `gh`, which must be logged in there.
//
//   npm run install:mac                 # latest release
//   npm run install:mac -- --version v0.1.1
//   npm run install:mac -- --open       # launch afterwards
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, mkdtempSync, readdirSync, renameSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { RELEASE_PUBLIC_KEYS, parseReleaseInfo, verifySignature } from "../bin/tau-update-helper.mjs";

/** Where releases are published (`publish:` in electron-builder.yml). */
export const RELEASES = "Rasalas/tau-releases";
/** Tags released before the public repository existed live only here. */
export const SOURCE_REPO = "Rasalas/tau";
export const MAC_FEED = "latest-mac.yml";
export const APP_NAME = "Tau.app";
export const INSTALL_DIR = "/Applications";

export function parseArgs(argv) {
  const options = { version: undefined, open: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") {
      const value = argv[++index];
      if (!value) throw new Error("--version needs a tag, e.g. v0.1.2");
      options.version = value;
    } else if (arg === "--open") options.open = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown flag ${JSON.stringify(arg)} (known: --version <tag>, --open)`);
  }
  return options;
}

/** The release's .dmg for an architecture: `Tau-1.2.3-arm64.dmg` on Apple silicon, `Tau-1.2.3.dmg` on Intel. */
export function dmgPattern(arch) {
  return arch === "arm64" ? "Tau-*-arm64.dmg" : "Tau-[0-9]*.dmg";
}

/** The command line inside an installed bundle; `asarUnpack` keeps it a real file. */
export function cliPath(app) {
  return join(app, "Contents", "Resources", "app.asar.unpacked", "bin", "tau.mjs");
}

export function pickDmg(names, arch) {
  const candidates = names.filter((name) => name.endsWith(".dmg") && !name.endsWith(".blockmap"));
  const wanted = arch === "arm64"
    ? candidates.filter((name) => name.endsWith("-arm64.dmg"))
    : candidates.filter((name) => !name.endsWith("-arm64.dmg"));
  if (wanted.length !== 1) throw new Error(`expected one .dmg for ${arch}, found: ${candidates.join(", ") || "none"}`);
  return wanted[0];
}

/** A file of a release in the public repository; the latest release when no tag is given. */
export function releaseUrl(tag, name) {
  const folder = tag ? `download/${encodeURIComponent(tag)}` : "latest/download";
  return `https://github.com/${RELEASES}/releases/${folder}/${encodeURIComponent(name)}`;
}

/**
 * The tag and the files of a release in the public repository, read from its
 * signed latest-mac.yml; undefined when the repository does not have it.
 */
export async function readRelease(fetchUrl, tag, keys = RELEASE_PUBLIC_KEYS) {
  const url = releaseUrl(tag, MAC_FEED);
  const response = await fetchUrl(url);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${url} answered ${response.status}.`);
  const text = await response.text();
  const signature = await fetchUrl(`${url}.sig`);
  if (!signature.ok || !verifySignature(text, await signature.text(), keys)) throw new Error(`${MAC_FEED} of ${tag ?? "the latest release"} is not signed by Tau's release key; nothing was installed.`);
  const { version, files } = parseReleaseInfo(text);
  if (!version) throw new Error(`${MAC_FEED} of ${tag ?? "the latest release"} names no version.`);
  if (tag && tag !== `v${version}`) throw new Error(`${MAC_FEED} of ${tag} is for ${version}.`);
  return { tag: `v${version}`, files: files.filter((file) => /^[\w.+-]+$/u.test(file.url)) };
}

/** Downloads `url` to `target` and keeps it only when it matches the release's SHA-512 and size. */
export async function downloadChecked(fetchUrl, url, target, expected) {
  const response = await fetchUrl(url);
  if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}.`);
  const hash = createHash("sha512");
  let size = 0;
  const count = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  const partial = `${target}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), count, createWriteStream(partial));
    if (hash.digest("base64") !== expected.sha512 || (expected.size !== undefined && size !== expected.size)) {
      throw new Error(`The download of ${url} does not match the release's checksum; nothing was installed.`);
    }
    renameSync(partial, target);
  } finally {
    rmSync(partial, { force: true });
  }
}

// An agent's shell may carry ELECTRON_RUN_AS_NODE; a launched Electron app inherits it and exits as plain Node.
const launchEnv = () => { const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; return env; };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8", env: launchEnv() });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }
  return result.stdout ?? "";
}

/** The .dmg in `workDir` and its tag: from the public repository, or with `gh` from the source repository. */
async function download(options, arch, workDir) {
  const release = await readRelease(fetch, options.version);
  if (release) {
    const file = release.files.find((entry) => entry.url === pickDmg(release.files.map((item) => item.url), arch));
    console.log(`Downloading ${release.tag} (${arch}) from ${RELEASES}…`);
    const dmg = join(workDir, file.url);
    await downloadChecked(fetch, releaseUrl(release.tag, file.url), dmg, file);
    return { tag: release.tag, dmg };
  }
  console.log(`${options.version ?? "The latest release"} is not in ${RELEASES}; trying ${SOURCE_REPO} with gh.`);
  run("gh", ["auth", "status"], { quiet: true });
  const tag = options.version ?? JSON.parse(execFileSync("gh", ["release", "view", "--repo", SOURCE_REPO, "--json", "tagName"], { encoding: "utf8" })).tagName;
  console.log(`Downloading ${tag} (${arch})…`);
  run("gh", ["release", "download", tag, "--repo", SOURCE_REPO, "--pattern", dmgPattern(arch), "--dir", workDir], { quiet: true });
  return { tag, dmg: join(workDir, pickDmg(readdirSync(workDir), arch)) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("npm run install:mac -- [--version <tag>] [--open]");
    return;
  }
  if (process.platform !== "darwin") throw new Error("install:mac runs on macOS only.");
  const arch = process.arch;
  const workDir = mkdtempSync(join(tmpdir(), "tau-install-"));
  let mountPoint;
  try {
    const { tag, dmg } = await download(options, arch, workDir);
    const attach = run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noverify", dmg], { quiet: true });
    mountPoint = attach.split("\n").map((line) => line.trim().split(/\t+/).pop()).find((path) => path && path.startsWith("/Volumes/"));
    if (!mountPoint) throw new Error("could not find where hdiutil mounted the image");
    const source = join(mountPoint, APP_NAME);
    if (!existsSync(source)) throw new Error(`${APP_NAME} is not in the image`);
    const target = join(INSTALL_DIR, APP_NAME);
    // A running copy is quit first; copying over a live bundle leaves a half-updated app.
    spawnSync("osascript", ["-e", 'tell application "Tau" to quit'], { stdio: "ignore" });
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    run("cp", ["-R", source, target], { quiet: true });
    // Gatekeeper blocks an unsigned download; the attribute is the "came from the internet" mark.
    spawnSync("xattr", ["-dr", "com.apple.quarantine", target], { stdio: "ignore" });
    console.log(`Installed ${tag} to ${target}`);
    // Nothing is put on the PATH unasked; this says how (README: "Open a folder from a terminal").
    console.log(`For \`tau app <path>\` in a terminal: ln -s "${cliPath(target)}" ~/.local/bin/tau`);
    if (options.open) run("open", ["-a", target], { quiet: true });
  } finally {
    if (mountPoint) spawnSync("hdiutil", ["detach", mountPoint, "-quiet"], { stdio: "ignore" });
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
