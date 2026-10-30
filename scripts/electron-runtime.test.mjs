import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveElectronRuntime } from "./electron-runtime.mjs";

const roots = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(output, { fail = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tau-electron-runtime-"));
  roots.push(root);
  const installed = join(root, "node_modules", "electron");
  await mkdir(installed, { recursive: true });
  const executable = join(installed, "Electron ü with spaces");
  const bytes = Buffer.from("fixture Electron binary");
  await writeFile(executable, bytes);
  await writeFile(join(installed, "package.json"), JSON.stringify({ main: "index.js", version: "44.10.0" }));
  await writeFile(join(installed, "index.js"), `
    if (process.env.ELECTRON_OVERRIDE_DIST_PATH) throw new Error("ambient runtime override leaked");
    console.log(${JSON.stringify(output)});
    ${fail ? 'throw new Error("download failed");' : `module.exports = ${JSON.stringify(executable)};`}
  `);
  const stdout = [];
  const run = (cwd, command, args, options) => {
    const result = execFileSync(command, args, { cwd, ...options, encoding: "utf8", timeout: 5_000, stdio: "pipe" });
    stdout.push(result);
    return result.trim();
  };
  return { root, executable, bytes, stdout, run };
}

describe("comparison Electron resolution", () => {
  it.each(["", "Downloading Electron binary...\nDownloaded successfully"])("keeps runtime metadata separate from stdout %j", async (output) => {
    const f = await fixture(output);
    vi.stubEnv("ELECTRON_OVERRIDE_DIST_PATH", "/unrelated/runtime");
    await expect(resolveElectronRuntime(f.root, f.root, f.run)).resolves.toEqual({
      executable: f.executable,
      electronVersion: "44.10.0",
      binarySha256: createHash("sha256").update(f.bytes).digest("hex"),
    });
    expect(f.stdout).toEqual([`${output}\n`]);
  });

  it("fails a runtime download instead of consuming stale metadata", async () => {
    const f = await fixture("Downloading Electron binary...", { fail: true });
    await writeFile(join(f.root, "electron-runtime.json"), JSON.stringify({ executable: f.executable, electronVersion: "44.10.0" }));
    await expect(resolveElectronRuntime(f.root, f.root, f.run)).rejects.toThrow(/download failed/u);
  });
});
