// Two fixes to node-pty as npm installs it, applied after every install.
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The npm tarball ships prebuilds/<platform>/spawn-helper without the execute bit; every terminal then fails with "posix_spawnp failed". */
export function restoreSpawnHelperMode(root) {
  const prebuilds = join(root, "prebuilds");
  if (!existsSync(prebuilds)) return;
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, "spawn-helper");
    if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
  }
}

/**
 * node-pty maps `app.asar` to `app.asar.unpacked` with a plain string replace.
 * Tau unpacks node_modules, so the path already says `app.asar.unpacked` and
 * the replace makes it `app.asar.unpacked.unpacked`: the packaged terminal
 * could not find spawn-helper. Only rewrite an `.asar` not already unpacked.
 */
export function patchAsarRewrite(source) {
  return source
    .replaceAll(".replace('app.asar', 'app.asar.unpacked')", ".replace(/app\\.asar(?!\\.unpacked)/, 'app.asar.unpacked')")
    .replaceAll(".replace('node_modules.asar', 'node_modules.asar.unpacked')", ".replace(/node_modules\\.asar(?!\\.unpacked)/, 'node_modules.asar.unpacked')");
}

export function fixNodePty(root) {
  if (!existsSync(root)) return;
  restoreSpawnHelperMode(root);
  for (const file of ["unixTerminal.js", "windowsConoutConnection.js"]) {
    const path = join(root, "lib", file);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    const patched = patchAsarRewrite(source);
    if (patched !== source) writeFileSync(path, patched);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) fixNodePty(join(process.cwd(), "node_modules", "node-pty"));
