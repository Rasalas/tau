// Real Chromium layout and wheel events, with no runtime or user data.
import { build } from "esbuild";
import electron from "electron";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

await mkdir(".tau-dev", { recursive: true });
const root = await mkdtemp(resolve(".tau-dev/transcript-scroll-"));
try {
  await build({
    entryPoints: ["src/renderer/test-support/transcript-scroll.electron.ts"],
    outfile: `${root}/probe.cjs`,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
  });
  const env = { ...process.env, TAU_NO_FOCUS: "1", TAU_SCROLL_TEST_HOME: root };
  delete env.ELECTRON_RUN_AS_NODE;
  process.exitCode = await new Promise((resolveCode, reject) => {
    const child = spawn(electron, [`${root}/probe.cjs`], { env, stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => { clearTimeout(timer); resolveCode(code ?? 1); });
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
