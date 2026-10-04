// Real Electron regression for a Mac window process that outlives its window.
import { build } from "esbuild";
import electron from "electron";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(".tau-dev/preview-window-lifecycle");
await mkdir(`${root}/userData`, { recursive: true });
await build({
  entryPoints: ["kits/preview/window-lifecycle.electron.ts"],
  outfile: `${root}/probe.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
});
const env = { ...process.env, TAU_NO_FOCUS: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [`${root}/probe.cjs`], { env, stdio: "inherit" });
const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
child.on("error", (error) => { console.error(error); clearTimeout(timer); process.exitCode = 1; });
child.on("exit", (code) => { clearTimeout(timer); process.exitCode = code ?? 1; });
