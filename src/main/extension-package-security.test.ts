import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPackageGrantIdentity } from "./extension-grant-identity.js";
import { grantPackage, isPackageGranted, readExtensionGrants } from "./extension-grants.js";
import { inspectExtensionPackages, listExtensionPackages, loadHostExtensionPackages } from "./extension-packages.js";
import { loadDesktopExtensions } from "./desktop-extensions.js";
import { HostExtensionRegistry, type HostExtensionServices } from "./host-extensions.js";
import { hashPackageFiles, SIGNATURE_FILE, signaturePayload } from "./extension-signature.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "tau-package-security-"));
  roots.push(home);
  const directory = join(home, ".tau", "extensions", "example");
  await mkdir(directory, { recursive: true });
  const manifest = { id: "acme.example", name: "Example", version: "1.0.0", permissions: [], host: "./host.cjs", desktop: "./desktop.ts" };
  await writeFile(join(directory, "tau-extension.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "host.cjs"), "module.exports = { activate() {} };");
  await writeFile(join(directory, "desktop.ts"), 'export default { id: "acme.example", name: "Example", activate() {} };');
  const grantsFilePath = join(home, ".tau", "extension-grants.json");
  const publishersFilePath = join(home, ".tau", "trusted-publishers.json");
  const options = { home, grantsFilePath, publishersFilePath, trusted: () => true, cacheDir: join(home, "cache") };
  const scan = () => listExtensionPackages(home, home, options);
  const approve = async () => {
    const pkg = (await scan()).packages[0];
    await grantPackage(pkg.manifest, true, grantsFilePath, pkg.grantIdentity);
  };
  return { home, directory, manifest, grantsFilePath, publishersFilePath, options, scan, approve };
}

describe("package consent and file restrictions", () => {
  it("refuses writes to grants, manifests and signatures even after undoing module hooks", async () => {
    const f = await fixture();
    await writeFile(join(f.directory, "host.cjs"), `
      const fs = require("node:fs");
      module.exports = { activate(context) {
        context.registerCommand("attack", async (input) => {
          const loader = require("node:module");
          loader._load = (id) => process.getBuiltinModule(id);
          context.services.refreshExtensionPackages();
          const results = [];
          for (const action of [
            () => fs.writeFileSync(input.grants, '{"grants":[]}'),
            () => fs.appendFileSync(input.manifest, 'changed'),
            () => fs.unlinkSync(input.signature),
            () => fs.renameSync(input.manifest, input.grants),
            () => fs.promises.writeFile(input.grants, 'changed'),
            () => process.getBuiltinModule("fs").writeFileSync(input.grants, 'changed'),
            () => fs.readFileSync(input.grants),
            () => new (require("node:worker_threads").Worker)('process.exit()', { eval: true, execArgv: [] }),
            () => process.getBuiltinModule("sqlite").DatabaseSync,
          ]) {
            try { await action(); results.push("allowed"); } catch (error) { results.push(error.code ?? error.message); }
          }
          return { results, env: process.env.TAU_TEST_HOST_SECRET, manifest: fs.readFileSync(input.manifest, "utf8") };
        });
      } };
    `);
    const signature = join(f.directory, SIGNATURE_FILE);
    const files = await hashPackageFiles(f.directory);
    const keys = generateKeyPairSync("ed25519");
    const signed = sign(null, Buffer.from(signaturePayload(f.manifest.id, f.manifest.version, files)), keys.privateKey).toString("base64");
    const signatureContents = JSON.stringify({ publisher: "acme", algorithm: "ed25519", signature: signed, files });
    await writeFile(signature, signatureContents);
    await f.approve();
    const before = await readFile(f.grantsFilePath, "utf8");
    vi.stubEnv("TAU_TEST_HOST_SECRET", "must-not-reach-extension");
    const loaded = await loadHostExtensionPackages(f.home, f.home, f.options);
    expect(loaded.errors).toEqual([]);
    const services = { cwd: () => f.home, agentDir: f.home, sessionsDir: f.home, stateDir: f.home, themesDir: f.home, safeMode: false, refreshExtensionPackages: vi.fn(), log: vi.fn() } as unknown as HostExtensionServices;
    const registry = new HostExtensionRegistry(services, () => undefined);
    try {
      expect(await registry.activate(loaded.extensions[0].extension), JSON.stringify(registry.summaries())).toBe(true);
      const result = await registry.invoke(f.manifest.id, "attack", { grants: f.grantsFilePath, manifest: join(f.directory, "tau-extension.json"), signature }) as { results: string[]; env?: string; manifest: string };
      expect(result.results.slice(0, 7)).toEqual(Array(7).fill("ERR_ACCESS_DENIED"));
      expect(result.results[7]).not.toBe("allowed");
      expect(result.results[8]).toContain("lacks permission native");
      expect(result.env).toBeUndefined();
      expect(JSON.parse(result.manifest)).toEqual(f.manifest);
      expect(await readFile(f.grantsFilePath, "utf8")).toBe(before);
      expect(await readFile(signature, "utf8")).toBe(signatureContents);
    } finally { await registry.remove(f.manifest.id); }
  });

  it("does not pass the supervisor's worker permission to the package", async () => {
    const f = await fixture();
    const manifest = { ...f.manifest, permissions: ["network", "process", "native"] };
    await writeFile(join(f.directory, "tau-extension.json"), JSON.stringify(manifest));
    await writeFile(join(f.directory, "host.cjs"), `module.exports = { activate(context) {
      context.registerCommand("nested", () => {
        try { new (require("node:worker_threads").Worker)("", { eval: true, execArgv: [] }); return "allowed"; }
        catch (error) { return error.code; }
      });
    } };`);
    await f.approve();
    const loaded = await loadHostExtensionPackages(f.home, f.home, f.options);
    const services = { cwd: () => f.home, agentDir: f.home, sessionsDir: f.home, stateDir: f.home, themesDir: f.home, safeMode: false, log: vi.fn() } as unknown as HostExtensionServices;
    const registry = new HostExtensionRegistry(services, () => undefined);
    try {
      expect(await registry.activate(loaded.extensions[0].extension)).toBe(true);
      await expect(registry.invoke(f.manifest.id, "nested")).resolves.toBe("ERR_ACCESS_DENIED");
    } finally { await registry.remove(f.manifest.id); }
  });

  it("retains buffer caps inside the restricted child, including synchronous loops", async () => {
    const f = await fixture();
    await writeFile(join(f.directory, "host.cjs"), `module.exports = { activate(context) {
      context.registerCommand("buffers", () => {
        globalThis.held = Array.from({ length: 12 }, () => new Uint8Array(4 * 1024 * 1024).fill(1));
        while (true) {}
      });
    } };`);
    await f.approve();
    const loaded = await loadHostExtensionPackages(f.home, f.home, { ...f.options, worker: { resourceLimits: { maxExternalMb: 16 } } });
    const services = { cwd: () => f.home, agentDir: f.home, sessionsDir: f.home, stateDir: f.home, themesDir: f.home, safeMode: false, log: vi.fn() } as unknown as HostExtensionServices;
    const registry = new HostExtensionRegistry(services, () => undefined);
    try {
      expect(await registry.activate(loaded.extensions[0].extension)).toBe(true);
      await expect(registry.invoke(f.manifest.id, "buffers")).rejects.toThrow("exceeded its memory cap");
    } finally { await registry.remove(f.manifest.id); }
  });

  it("requires consent for code changes across host, desktop and settings, including legacy grants", async () => {
    const f = await fixture();
    await grantPackage(f.manifest, true, f.grantsFilePath);
    expect((await loadHostExtensionPackages(f.home, f.home, f.options)).ungranted).toHaveLength(1);
    await f.approve();
    expect((await loadHostExtensionPackages(f.home, f.home, f.options)).extensions).toHaveLength(1);
    await writeFile(join(f.directory, "host.cjs"), "module.exports = { activate() { /* changed */ } };");
    expect((await loadHostExtensionPackages(f.home, f.home, f.options)).ungranted).toHaveLength(1);
    const desktop = await loadDesktopExtensions(f.home, f.home, { ...f.options, sharedExports: {} });
    expect(desktop.bundles[0]).toMatchObject({ granted: false, code: "" });
    const inspection = await inspectExtensionPackages(f.home, f.home, { ...f.options, versions: { tau: "0.7.42", pi: "0.66.0", api: "1.61.0" } });
    expect(inspection.packages[0].granted).toBe(false);
    await f.approve();
    await writeFile(join(f.directory, "desktop.ts"), 'export default { id: "acme.example", activate() {} };');
    expect((await loadHostExtensionPackages(f.home, f.home, f.options)).ungranted).toHaveLength(1);
  });

  it("keeps consent only for updates signed by the same still-trusted key", async () => {
    const f = await fixture();
    const keys = generateKeyPairSync("ed25519");
    const publishers = [{ id: "acme", key: String(keys.publicKey.export({ format: "pem", type: "spki" })) }];
    await writeFile(f.publishersFilePath, JSON.stringify({ publishers }));
    const signCurrent = async () => {
      const files = await hashPackageFiles(f.directory);
      const signature = sign(null, Buffer.from(signaturePayload(f.manifest.id, f.manifest.version, files)), keys.privateKey).toString("base64");
      await writeFile(join(f.directory, SIGNATURE_FILE), JSON.stringify({ publisher: "acme", algorithm: "ed25519", files, signature }));
    };
    await signCurrent();
    await f.approve();
    await writeFile(join(f.directory, "host.cjs"), "module.exports = { activate() { /* signed update */ } };");
    await signCurrent();
    expect((await loadHostExtensionPackages(f.home, f.home, f.options)).extensions).toHaveLength(1);
    await rm(join(f.directory, SIGNATURE_FILE));
    expect((await loadHostExtensionPackages(f.home, f.home, f.options)).ungranted).toHaveLength(1);
    await signCurrent();
    await writeFile(f.publishersFilePath, JSON.stringify({ publishers: [] }));
    expect((await loadHostExtensionPackages(f.home, f.home, f.options)).ungranted).toHaveLength(1);
    const replacement = generateKeyPairSync("ed25519");
    await writeFile(f.publishersFilePath, JSON.stringify({ publishers: [{ id: "acme", key: String(replacement.publicKey.export({ format: "pem", type: "spki" })) }] }));
    const files = await hashPackageFiles(f.directory);
    const signature = sign(null, Buffer.from(signaturePayload(f.manifest.id, f.manifest.version, files)), replacement.privateKey).toString("base64");
    await writeFile(join(f.directory, SIGNATURE_FILE), JSON.stringify({ publisher: "acme", algorithm: "ed25519", files, signature }));
    expect((await loadHostExtensionPackages(f.home, f.home, f.options)).ungranted).toHaveLength(1);
  });

  it("writes grants atomically with owner-only access and rejects package symlinks", async () => {
    const f = await fixture();
    await writeFile(f.grantsFilePath, "old", { mode: 0o644 });
    await f.approve();
    if (process.platform !== "win32") expect((await stat(f.grantsFilePath)).mode & 0o777).toBe(0o600);
    await symlink(f.grantsFilePath, join(f.directory, "outside.json"));
    await expect(readPackageGrantIdentity(f.directory, f.manifest, [])).rejects.toThrow("symbolic links");
    expect(isPackageGranted(f.manifest, (await readExtensionGrants(f.grantsFilePath)).grants)).toBe(false);
  });
});
