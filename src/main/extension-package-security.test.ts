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
  const stateRoot = join(home, "userData", "kit-state");
  const agentDir = join(home, "agent");
  const sessionsDir = join(home, "sessions");
  const themesDir = join(home, "themes");
  return { stateRoot, agentDir, sessionsDir, themesDir, home, directory, manifest, grantsFilePath, publishersFilePath, options, scan, approve };
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
    const services = { cwd: () => f.home, agentDir: f.agentDir, sessionsDir: f.sessionsDir, stateDir: f.stateRoot, themesDir: f.themesDir, safeMode: false, refreshExtensionPackages: vi.fn(), log: vi.fn() } as unknown as HostExtensionServices;
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

  it("reads and writes only its own data folder, without any permissions", async () => {
    const f = await fixture();
    const otherStateDir = join(f.stateRoot, "acme.other");
    for (const directory of [f.agentDir, f.sessionsDir, f.themesDir, otherStateDir]) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "private.txt"), "private");
    }
    await writeFile(join(f.directory, "host.cjs"), `
      const fs = require("node:fs/promises");
      const { join } = require("node:path");
      module.exports = { activate({ services, registerCommand }) {
        registerCommand("data", async ({ otherStateDir, manifest }) => {
          const file = join(services.stateDir, "data.json");
          await fs.writeFile(file, "saved");
          const denied = [];
          for (const directory of [services.agentDir, services.sessionsDir, services.themesDir, otherStateDir]) {
            const privateFile = join(directory, "private.txt");
            for (const action of [() => fs.readFile(privateFile), () => fs.writeFile(privateFile, "changed")]) {
              try { await action(); denied.push("allowed"); } catch (error) { denied.push(error.code); }
            }
          }
          for (const [link, target] of [["symlink", join(otherStateDir, "private.txt")], ["link", manifest]]) {
            const escape = join(services.stateDir, link);
            try { await fs[link](target, escape); await fs.writeFile(escape, "changed"); denied.push("allowed"); }
            catch (error) { denied.push(error.code); }
          }
          return { saved: await fs.readFile(file, "utf8"), denied };
        });
      } };
    `);
    await f.approve();
    const loaded = await loadHostExtensionPackages(f.home, f.home, f.options);
    const services = { cwd: () => f.home, agentDir: f.agentDir, sessionsDir: f.sessionsDir, stateDir: f.stateRoot, themesDir: f.themesDir, safeMode: false, log: vi.fn() } as unknown as HostExtensionServices;
    const registry = new HostExtensionRegistry(services, () => undefined);
    try {
      expect(await registry.activate(loaded.extensions[0].extension), JSON.stringify(registry.summaries())).toBe(true);
      await expect(registry.invoke(f.manifest.id, "data", { otherStateDir, manifest: join(f.directory, "tau-extension.json") })).resolves.toEqual({ saved: "saved", denied: Array(10).fill("ERR_ACCESS_DENIED") });
      expect(await readFile(join(f.stateRoot, f.manifest.id, "data.json"), "utf8")).toBe("saved");
      expect(JSON.parse(await readFile(join(f.directory, "tau-extension.json"), "utf8"))).toEqual(f.manifest);
      for (const directory of [f.agentDir, f.sessionsDir, f.themesDir, otherStateDir]) {
        expect(await readFile(join(directory, "private.txt"), "utf8")).toBe("private");
      }
    } finally { await registry.remove(f.manifest.id); }
  });

  it.each(["root", "nested", "wildcard"])("rejects a %s escape in the data folder before starting", async (kind) => {
    const f = await fixture();
    const stateRoot = kind === "wildcard" ? `${f.stateRoot}*` : f.stateRoot;
    const stateDir = join(stateRoot, f.manifest.id);
    if (kind === "root") {
      await mkdir(stateRoot, { recursive: true });
      await symlink(f.directory, stateDir);
    } else if (kind === "nested") {
      await mkdir(stateDir, { recursive: true });
      await symlink(f.grantsFilePath, join(stateDir, "grants.json"));
    }
    await f.approve();
    const loaded = await loadHostExtensionPackages(f.home, f.home, f.options);
    const services = { cwd: () => f.home, agentDir: f.agentDir, sessionsDir: f.sessionsDir, stateDir: stateRoot, themesDir: f.themesDir, safeMode: false, log: vi.fn() } as unknown as HostExtensionServices;
    const registry = new HostExtensionRegistry(services, () => undefined);
    try {
      expect(await registry.activate(loaded.extensions[0].extension)).toBe(false);
      expect(registry.summaries()[0].error).toContain(kind === "wildcard" ? "wildcards" : "symbolic links");
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
    const services = { cwd: () => f.home, agentDir: f.agentDir, sessionsDir: f.sessionsDir, stateDir: f.stateRoot, themesDir: f.themesDir, safeMode: false, log: vi.fn() } as unknown as HostExtensionServices;
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
    const services = { cwd: () => f.home, agentDir: f.agentDir, sessionsDir: f.sessionsDir, stateDir: f.stateRoot, themesDir: f.themesDir, safeMode: false, log: vi.fn() } as unknown as HostExtensionServices;
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
