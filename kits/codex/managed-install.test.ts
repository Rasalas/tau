import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedCodex, MANAGED_CODEX_VERSION } from "./managed-install.js";
import { managedCodexAsset } from "./managed-release.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture(options: { link?: boolean; platform?: string; wrongVersion?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tau-managed-codex-"));
  directories.push(root);
  const source = join(root, "source");
  await mkdir(join(source, "bin"), { recursive: true });
  const entrypoint = `bin/codex${options.platform === "win32" ? ".exe" : ""}`;
  await writeFile(join(source, entrypoint), "codex executable fixture");
  await chmod(join(source, entrypoint), 0o755);
  await writeFile(join(source, "bin/helper"), "required helper");
  await chmod(join(source, "bin/helper"), 0o755);
  await writeFile(join(source, "codex-package.json"), JSON.stringify({ version: options.wrongVersion ? "0.0.0" : MANAGED_CODEX_VERSION, target: "fixture-target", entrypoint }));
  if (options.link) await symlink("/outside", join(source, "bin/link"));
  const file = join(root, "fixture.tar.gz");
  await create({ file, cwd: source, gzip: true, portable: true }, ["bin", "codex-package.json"]);
  const archive = await readFile(file);
  const fetcher = vi.fn(async () => new Response(new Uint8Array(archive)));
  const directory = join(root, "managed");
  const asset = { target: "fixture-target", bytes: archive.length, sha256: createHash("sha256").update(archive).digest("hex") };
  const config = { directory, platform: options.platform ?? "linux", arch: "x64", asset, fetch: fetcher as typeof fetch };
  return { root, directory, archive, fetcher, config, installer: createManagedCodex(config) };
}

describe("managed Codex", () => {
  it("installs and reuses a verified complete package without consulting a system CLI", async () => {
    const { installer, fetcher } = await fixture();
    const onProgress = vi.fn();
    expect(await installer.resolveInstalled()).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    const path = await installer.ensure({ onProgress });
    expect(await readFile(path, "utf8")).toBe("codex executable fixture");
    expect(await installer.ensure()).toBe(path);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls.at(-1)?.[0]).toEqual({ phase: "installed" });
  });

  it("removes the release it replaced once the pinned one is installed", async () => {
    const { installer, directory } = await fixture();
    await mkdir(join(directory, "0.100.0-linux-x64", "bin"), { recursive: true });
    await mkdir(join(directory, "0.100.0-darwin-arm64"), { recursive: true });
    expect(await installer.hadEarlier()).toBe(true);
    const path = await installer.ensure();
    expect((await readdir(directory)).sort()).toEqual(["0.100.0-darwin-arm64", `${MANAGED_CODEX_VERSION}-linux-x64`]);
    expect(await installer.hadEarlier()).toBe(false);
    expect(await installer.resolveInstalled()).toBe(path);
  });

  it("shares concurrent installs across callers", async () => {
    const { installer, config, fetcher } = await fixture();
    const [first, second] = await Promise.all([installer.ensure(), createManagedCodex(config).ensure()]);
    expect(first).toBe(second);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects altered downloads and leaves no partial installation", async () => {
    const { config, directory } = await fixture();
    const installer = createManagedCodex({ ...config, asset: { ...config.asset, sha256: "0".repeat(64) } });
    await expect(installer.ensure()).rejects.toThrow("SHA-256");
    expect(await installer.resolveInstalled()).toBeUndefined();
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects an oversized response before extracting", async () => {
    const { config } = await fixture();
    const installer = createManagedCodex({ ...config, asset: { ...config.asset, bytes: 1 } });
    await expect(installer.ensure()).rejects.toThrow("larger");
  });

  it("rejects links even in an archive with the expected digest", async () => {
    const { installer } = await fixture({ link: true });
    await expect(installer.ensure()).rejects.toThrow("unsupported entries");
    expect(await installer.resolveInstalled()).toBeUndefined();
  });

  it("checks package identity before publishing the installation", async () => {
    const { installer } = await fixture({ wrongVersion: true });
    await expect(installer.ensure()).rejects.toThrow("pinned release");
    expect(await installer.resolveInstalled()).toBeUndefined();
  });

  it("notices a missing helper and repairs the package", async () => {
    const { installer, fetcher } = await fixture();
    const path = await installer.ensure();
    await rm(join(path, "..", "helper"));
    expect(await installer.resolveInstalled()).toBeUndefined();
    expect(await installer.ensure()).toBe(path);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses the Windows package entrypoint", async () => {
    const { installer } = await fixture({ platform: "win32" });
    expect(await installer.ensure()).toMatch(/codex\.exe$/u);
  });

  it("does not download on an unsupported platform", async () => {
    const { config, fetcher } = await fixture();
    const installer = createManagedCodex({ ...config, asset: undefined, platform: "freebsd" });
    await expect(installer.ensure()).rejects.toThrow("freebsd-x64");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("can retry after cancellation", async () => {
    const { installer } = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(installer.ensure({ signal: controller.signal })).rejects.toThrow();
    expect(await installer.ensure()).toBe(await installer.resolveInstalled());
  });

  it.each(["darwin", "linux", "win32"])("pins complete %s packages for both architectures", (platform) => {
    for (const arch of ["arm64", "x64"]) {
      const asset = managedCodexAsset(platform, arch);
      expect(asset?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(asset?.bytes).toBeGreaterThan(100_000_000);
    }
  });
});
