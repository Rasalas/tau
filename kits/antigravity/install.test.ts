import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installAntigravity, managedDirectory, resolveAntigravity } from "./install.js";
import type { ReleaseAsset } from "./release.js";
import { buildZip } from "./zip-fixture.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-agy-"));
  directories.push(directory);
  return directory;
}

const server = Buffer.from("#!/bin/sh\necho server\n");
const harness = Buffer.from("#!/bin/sh\necho harness\n");

function release(archive: Buffer, overrides: Partial<ReleaseAsset> = {}): ReleaseAsset {
  return {
    key: "darwin-arm64",
    version: "agy_acp_server_test",
    url: "https://dl.example.invalid/agy.zip",
    sha256: createHash("sha256").update(archive).digest("hex"),
    archiveBytes: archive.length,
    executable: { name: "agy_acp_server.par", bytes: server.length },
    harness: { name: "localharness_external", bytes: harness.length },
    ...overrides,
  };
}

function fetchServing(archive: Buffer): typeof fetch {
  return vi.fn(async () => new Response(new Blob([new Uint8Array(archive)]).stream(), { status: 200 })) as unknown as typeof fetch;
}

describe("Antigravity installation", () => {
  it("downloads, verifies, extracts and activates the pinned release, then resolves it as managed", async () => {
    const stateDir = await scratch();
    const archive = buildZip([{ name: "agy_acp_server.par", data: server }, { name: "localharness_external", data: harness, method: 0 }]);
    const asset = release(archive);
    const phases: string[] = [];
    const validate = vi.fn(async () => undefined);
    const installed = await installAntigravity({ stateDir, platform: "darwin", arch: "arm64", asset, fetch: fetchServing(archive), onProgress: (event) => phases.push(event.phase), validate });
    expect(installed.source).toBe("managed");
    expect(installed.version).toBe("agy_acp_server_test");
    expect(validate).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(["downloading", "extracting", "verifying", "installed"]);
    const managed = managedDirectory(stateDir, "darwin", "arm64");
    expect(JSON.parse(await readFile(join(managed, "active.json"), "utf8"))).toEqual({ releaseId: asset.sha256 });
    expect((await readFile(installed.executablePath)).equals(server)).toBe(true);

    const resolved = await resolveAntigravity({ stateDir, platform: "darwin", arch: "arm64", findCommand: () => undefined });
    expect(resolved).toEqual(installed);
    // A second install of the same release reuses the verified copy without fetching.
    const again = await installAntigravity({ stateDir, platform: "darwin", arch: "arm64", asset, fetch: vi.fn(async () => { throw new Error("no network"); }) as unknown as typeof fetch });
    expect(again.executablePath).toBe(installed.executablePath);
  });

  it("rejects a download whose hash or size differs, and an archive with the wrong members", async () => {
    const stateDir = await scratch();
    const archive = buildZip([{ name: "agy_acp_server.par", data: server }, { name: "localharness_external", data: harness }]);
    await expect(installAntigravity({ stateDir, platform: "darwin", arch: "arm64", asset: release(archive, { sha256: "0".repeat(64) }), fetch: fetchServing(archive) }))
      .rejects.toThrow(/size or SHA-256/u);
    const extra = buildZip([{ name: "agy_acp_server.par", data: server }, { name: "localharness_external", data: harness }, { name: "extra", data: Buffer.from("x") }]);
    await expect(installAntigravity({ stateDir, platform: "darwin", arch: "arm64", asset: release(extra), fetch: fetchServing(extra) }))
      .rejects.toThrow(/3 members/u);
    const renamed = buildZip([{ name: "agy_acp_server.par", data: server }, { name: "other", data: harness }]);
    await expect(installAntigravity({ stateDir, platform: "darwin", arch: "arm64", asset: release(renamed), fetch: fetchServing(renamed) }))
      .rejects.toThrow(/unexpected, unsafe/u);
    await expect(resolveAntigravity({ stateDir, platform: "darwin", arch: "arm64", findCommand: () => undefined })).rejects.toThrow(/not installed/u);
  });

  it("takes an override or a PATH copy only with the harness beside it", async () => {
    const directory = await scratch();
    const executable = join(directory, "agy_acp_server.par");
    await writeFile(executable, server, { mode: 0o755 });
    await expect(resolveAntigravity({ override: executable, stateDir: directory, platform: "darwin", arch: "arm64", findCommand: () => undefined })).rejects.toThrow(/localharness_external beside it/u);
    await writeFile(join(directory, "localharness_external"), harness, { mode: 0o755 });
    await chmod(join(directory, "localharness_external"), 0o755);
    expect(await resolveAntigravity({ override: executable, stateDir: directory, platform: "darwin", arch: "arm64", findCommand: () => undefined })).toMatchObject({ source: "override", harnessPath: join(directory, "localharness_external") });
    expect(await resolveAntigravity({ override: "agy_acp_server.par", stateDir: directory, platform: "darwin", arch: "arm64", findCommand: (name) => name === "agy_acp_server.par" ? executable : undefined })).toMatchObject({ source: "override" });
    await mkdir(join(directory, "state"));
    expect(await resolveAntigravity({ stateDir: join(directory, "state"), platform: "darwin", arch: "arm64", findCommand: (name) => name === "agy_acp_server.par" ? executable : undefined })).toMatchObject({ source: "path" });
  });
});
