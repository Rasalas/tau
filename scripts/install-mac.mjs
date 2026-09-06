#!/usr/bin/env node
// Installs a released Tau on this Mac: downloads the .dmg that matches this
// machine's architecture from the GitHub release, copies Tau.app into
// /Applications, and strips the quarantine attribute Gatekeeper would
// otherwise block an unsigned app on. `gh` does the download because the
// repository is private; it must be logged in (`gh auth status`).
//
//   npm run install:mac                 # latest release
//   npm run install:mac -- --version v0.1.1
//   npm run install:mac -- --open       # launch afterwards
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPO = "Rasalas/tau";
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

export function pickDmg(names, arch) {
  const candidates = names.filter((name) => name.endsWith(".dmg") && !name.endsWith(".blockmap"));
  const wanted = arch === "arm64"
    ? candidates.filter((name) => name.endsWith("-arm64.dmg"))
    : candidates.filter((name) => !name.endsWith("-arm64.dmg"));
  if (wanted.length !== 1) throw new Error(`expected one .dmg for ${arch}, found: ${candidates.join(", ") || "none"}`);
  return wanted[0];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }
  return result.stdout ?? "";
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("npm run install:mac -- [--version <tag>] [--open]");
    return;
  }
  if (process.platform !== "darwin") throw new Error("install:mac runs on macOS only.");
  run("gh", ["auth", "status"], { quiet: true });
  const tag = options.version ?? JSON.parse(execFileSync("gh", ["release", "view", "--repo", REPO, "--json", "tagName"], { encoding: "utf8" })).tagName;
  const arch = process.arch;
  const workDir = mkdtempSync(join(tmpdir(), "tau-install-"));
  let mountPoint;
  try {
    console.log(`Downloading ${tag} (${arch})…`);
    run("gh", ["release", "download", tag, "--repo", REPO, "--pattern", dmgPattern(arch), "--dir", workDir], { quiet: true });
    const dmg = join(workDir, pickDmg(readdirSync(workDir), arch));
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
    if (options.open) run("open", ["-a", target], { quiet: true });
  } finally {
    if (mountPoint) spawnSync("hdiutil", ["detach", mountPoint, "-quiet"], { stdio: "ignore" });
    rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
