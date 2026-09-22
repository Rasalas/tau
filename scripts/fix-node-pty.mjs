// node-pty's npm tarball ships prebuilds/*/spawn-helper without the execute bit;
// without it every terminal fails with "posix_spawnp failed".
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const prebuilds = join(process.cwd(), "node_modules", "node-pty", "prebuilds");
if (existsSync(prebuilds)) {
  for (const platform of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platform, "spawn-helper");
    if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
  }
}
