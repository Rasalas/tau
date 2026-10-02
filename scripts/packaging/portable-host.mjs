#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, lstatSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { isMain, main } from "./release.mjs";

/** Package the platform's already built app, including its embedded runtime and native dependencies. */
export function portableHost({ root, out, platform, arch, version, run = execFileSync }) {
  if (!["linux", "darwin", "win32"].includes(platform) || !["x64", "arm64"].includes(arch) || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u.test(version)) throw new Error("Invalid portable host target.");
  const executable = platform === "darwin" ? "Tau.app/Contents/MacOS/Tau" : platform === "win32" ? "Tau.exe" : "tau";
  if (!existsSync(join(root, executable))) throw new Error(`The built app lacks ${executable}.`);
  const canonical = realpathSync(root);
  for (const entry of readdirSync(root, { recursive: true })) {
    const path = join(root, entry);
    if (lstatSync(path).isSymbolicLink()) {
      const destination = realpathSync(path);
      if (destination !== canonical && !destination.startsWith(`${canonical}${sep}`)) throw new Error(`The portable app has a symlink outside its archive: ${entry}.`);
    }
  }
  const name = `Tau-host-${version}-${platform}-${arch}.${platform === "win32" ? "zip" : "tar.gz"}`;
  const path = resolve(out, name);
  if (platform === "win32") {
    // Windows' own bsdtar writes zip; the GNU tar first on Git Bash's PATH cannot, and reads "D:" as a host.
    run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), ["-a", "-cf", path, "-C", root, "."]);
  } else run("tar", ["-czf", path, "-C", root, "."]);
  const sha512 = createHash("sha512").update(readFileSync(path)).digest("base64");
  const feed = `version: ${version}\nfiles:\n  - url: ${basename(path)}\n    sha512: ${sha512}\n    size: ${statSync(path).size}\n`;
  writeFileSync(join(out, `latest-host-${platform}-${arch}.yml`), feed);
  return path;
}

export function findPortableRoot(folder, platform, arch) {
  const directories = readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(folder, entry.name));
  // electron-builder's app folders: mac, mac-arm64, linux-unpacked, linux-arm64-unpacked, win-unpacked. Its
  // staging folders (an AppImage's, say) hold the executable too, so elsewhere only "-unpacked" counts.
  const matches = directories.filter((root) => existsSync(join(root, platform === "darwin" ? "Tau.app" : platform === "win32" ? "Tau.exe" : "tau"))
    && (platform === "darwin" || basename(root).endsWith("-unpacked"))
    && basename(root).includes("arm64") === (arch === "arm64"));
  if (matches.length !== 1) throw new Error(`Expected one built ${platform}/${arch} app, found ${matches.length}.`);
  return matches[0];
}

if (isMain(import.meta.url)) main(() => {
  const platform = process.platform;
  // A macOS x64 package can be built by an arm64 runner.
  const arch = process.argv[2] ?? process.arch;
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  console.log(portableHost({ root: findPortableRoot("release", platform, arch), out: "release", platform, arch, version }));
});
