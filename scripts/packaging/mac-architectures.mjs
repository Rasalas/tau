// electron-builder hooks that keep each Mac app to its own architecture. The
// release builds the arm64 and the x64 app on one arm64 runner from one
// `npm ci`, which installs only the arm64 optional platform packages
// (esbuild's binary, rollup's, xa11y's). `beforeBuild` unpacks the ones npm
// skipped, at the versions the lockfile pins; `files` in electron-builder.yml
// drops the other architecture's copies and prebuilds; `afterPack` fails the
// build when a native file for another architecture still got in.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// Left out of the app by `files` anyway (electron-builder.yml); ~200 MB each.
const NOT_SHIPPED = [/\/@anthropic-ai\/claude-agent-sdk-/u];

/** Lockfile entries of production packages built for exactly this macOS architecture. */
export function macPackagesFor(lock, arch) {
  const packages = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path || entry.dev || entry.link) continue;
    if (!entry.os?.includes("darwin") || entry.cpu?.length !== 1 || entry.cpu[0] !== arch) continue;
    if (NOT_SHIPPED.some((pattern) => pattern.test(path))) continue;
    const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    packages.push({ path, name, version: entry.version, integrity: entry.integrity });
  }
  return packages;
}

function sameIntegrity(file, integrity) {
  const [algorithm, expected] = integrity.split(/-(.*)/su);
  return createHash(algorithm).update(readFileSync(file)).digest("base64") === expected;
}

/** Unpacks the missing packages for `arch` into `root`'s node_modules; answers with the ones it added. */
export function installMacPackages(root, arch, log = console.log) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const missing = macPackagesFor(lock, arch).filter((pkg) => !existsSync(join(root, pkg.path, "package.json")));
  if (missing.length === 0) return [];
  const scratch = mkdtempSync(join(tmpdir(), "tau-mac-packages-"));
  try {
    for (const pkg of missing) {
      if (!pkg.integrity) throw new Error(`package-lock.json has no integrity for ${pkg.path}.`);
      // npm's own fetch: its cache, registry and proxy settings apply.
      const [packed] = JSON.parse(execFileSync("npm", ["pack", `${pkg.name}@${pkg.version}`, "--json", "--silent", "--pack-destination", scratch], { cwd: scratch, encoding: "utf8" }));
      const tarball = join(scratch, packed.filename);
      if (!sameIntegrity(tarball, pkg.integrity)) throw new Error(`${pkg.name}@${pkg.version} does not match the integrity in package-lock.json.`);
      const target = join(root, pkg.path);
      mkdirSync(target, { recursive: true });
      execFileSync("tar", ["-xzf", tarball, "-C", target, "--strip-components", "1"]);
      log(`  • added ${pkg.name}@${pkg.version} for ${arch} at ${pkg.path}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return missing;
}

const CPU_TYPES = new Map([[0x7, "ia32"], [0xc, "arm"], [0x0100_0007, "x64"], [0x0100_000c, "arm64"], [0x0200_000c, "arm64_32"]]);
const cpuName = (type) => CPU_TYPES.get(type) ?? `cpu 0x${type.toString(16)}`;

/** The architectures a Mach-O header names, or undefined for any other file. */
export function machOArchitectures(header) {
  if (header.length < 8) return undefined;
  const little = header.readUInt32LE(0);
  if (little === 0xfeedface || little === 0xfeedfacf) return [cpuName(header.readUInt32LE(4))];
  const big = header.readUInt32BE(0);
  if (big === 0xfeedface || big === 0xfeedfacf) return [cpuName(header.readUInt32BE(4))];
  if (big !== 0xcafebabe && big !== 0xcafebabf) return undefined;
  // A Java class file starts with the same magic, followed by a class version of 45 or more.
  const count = header.readUInt32BE(4);
  const size = big === 0xcafebabf ? 32 : 20;
  if (count === 0 || count >= 45 || header.length < 8 + count * size) return undefined;
  return Array.from({ length: count }, (_, index) => cpuName(header.readUInt32BE(8 + index * size)));
}

function readHeader(file) {
  const header = Buffer.alloc(512);
  const fd = openSync(file, "r");
  try {
    return header.subarray(0, readSync(fd, header, 0, header.length, 0));
  } finally {
    closeSync(fd);
  }
}

/** Every Mach-O file under `dir` that cannot run as `arch`, with the architectures it has. */
export function foreignMachOFiles(dir, arch) {
  const foreign = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const architectures = machOArchitectures(readHeader(file));
    if (architectures && !architectures.includes(arch)) foreign.push({ file: relative(dir, file), architectures });
  }
  return foreign;
}

export async function beforeBuild(context) {
  if (context.platform.nodeName === "darwin") installMacPackages(context.appDir, context.arch);
  // Anything but true tells electron-builder to skip its own native rebuild.
  return true;
}

// builder-util's `Arch` enum, which afterPack gets as a number.
const PACKED_ARCH = new Map([[1, "x64"], [3, "arm64"]]);

export async function afterPack(context) {
  const arch = PACKED_ARCH.get(context.arch);
  if (context.electronPlatformName !== "darwin" || !arch) return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const foreign = foreignMachOFiles(app, arch);
  if (foreign.length === 0) {
    console.log(`  • checked the ${arch} app: every native file runs on ${arch}`);
    return;
  }
  const list = foreign.map(({ file, architectures }) => `  ${file} (${architectures.join(", ")})`).join("\n");
  throw new Error(`The ${arch} app contains native files that cannot run on ${arch}:\n${list}`);
}
