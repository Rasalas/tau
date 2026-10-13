import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installExtensionSource, listExtensionSources, removeExtensionSource, updateExtensionSources } from "./extension-installer.js";
import { packagesFilePath, readPackagesFile, writePackagesFile } from "./extension-sources.js";
import { create as createTar } from "tar";
import { SIGNATURE_FILE, hashPackageFiles, signaturePayload } from "./extension-signature.js";
import { listExtensionPackages } from "./extension-packages.js";
import { readPackageGrantIdentity } from "./extension-grant-identity.js";
import { grantPackage, isPackageGranted, readExtensionGrants } from "./extension-grants.js";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-install-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

interface PackageFields {
  id?: string;
  name?: string;
  version?: string;
  permissions?: string[];
}

async function packageFolder(root: string, folder: string, fields: PackageFields = {}): Promise<string> {
  const dir = join(root, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "tau-extension.json"), JSON.stringify({
    id: fields.id ?? "acme.hello",
    name: fields.name ?? "Hello",
    version: fields.version ?? "1.0.0",
    ...(fields.permissions ? { permissions: fields.permissions } : {}),
    host: "./host.ts",
  }));
  await writeFile(join(dir, "host.ts"), "export default { activate() {} }");
  return dir;
}

describe("extension installer", () => {
  it("installs an npm package without running its postinstall script, including on update", async () => {
    const home = await scratch();
    const project = await scratch();
    const fixture = await scratch();
    const source = await packageFolder(fixture, "package");
    const marker = join(fixture, "postinstall-ran");
    await writeFile(join(source, "package.json"), JSON.stringify({
      name: "tau-test-lifecycle", version: "1.0.0", scripts: { postinstall: "node postinstall.cjs" },
    }));
    await writeFile(join(source, "postinstall.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`);
    const archive = join(fixture, "package.tgz");
    await createTar({ gzip: true, file: archive, cwd: fixture }, ["package"]);
    const config = join(fixture, "npmrc");
    const globalConfig = join(fixture, "global-npmrc");
    await writeFile(config, "");
    await writeFile(globalConfig, "");
    const shim = join(fixture, "npm");
    // Use real npm with a local tarball in place of the registry package.
    await writeFile(shim, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
args.pop();
args.push(${JSON.stringify(archive)}, "--offline");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
const result = spawnSync("npm", args, { stdio: "inherit", env: { ...env,
  npm_config_cache: ${JSON.stringify(join(fixture, "cache"))},
  npm_config_userconfig: ${JSON.stringify(config)}, npm_config_globalconfig: ${JSON.stringify(globalConfig)},
  npm_config_ignore_scripts: "false"
} });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`);
    await chmod(shim, 0o755);
    const options = { cwd: project, home, findCommand: (name: string) => name === "npm" ? shim : undefined };
    const installed = await installExtensionSource("npm:tau-test-lifecycle", "global", options);
    expect(installed).toMatchObject({ id: "acme.hello", directory: join(home, ".tau", "npm", "node_modules", "tau-test-lifecycle") });
    expect((await readPackagesFile(packagesFilePath("global", project, home))).sources).toEqual(["npm:tau-test-lifecycle"]);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await rm(installed.directory, { recursive: true, force: true });
    expect(await updateExtensionSources(undefined, options)).toMatchObject([{ id: "acme.hello" }]);
    await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("updates only global sources in an untrusted project", async () => {
    const home = await scratch();
    const project = await scratch();
    const global = await packageFolder(await scratch(), "global");
    const projectSource = "git:https://example.com/acme/project.git";
    await writePackagesFile(packagesFilePath("global", project, home), { sources: [global] });
    await writePackagesFile(packagesFilePath("project", project, home), { sources: [projectSource] });
    const options = { cwd: project, home, findCommand: () => { throw new Error("Project source was fetched"); } };
    expect(await updateExtensionSources(undefined, options)).toMatchObject([{ id: "acme.hello", scope: "global" }]);
    await expect(updateExtensionSources(projectSource, options)).rejects.toThrow(/trust this project/iu);
    expect(await updateExtensionSources(global, options)).toMatchObject([{ id: "acme.hello", scope: "global" }]);
  });

  it("does not read or quarantine the packages file of an untrusted project", async () => {
    const home = await scratch();
    const project = await scratch();
    const file = packagesFilePath("project", project, home);
    await mkdir(join(project, ".tau"));
    await writeFile(file, "invalid JSON");
    expect(await updateExtensionSources(undefined, { cwd: project, home })).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("invalid JSON");
  });

  it("updates project sources when the project is trusted", async () => {
    const home = await scratch();
    const project = await scratch();
    const local = await packageFolder(project, "local", { id: "acme.local" });
    await writePackagesFile(packagesFilePath("project", project, home), { sources: ["./local"] });
    const options = { cwd: project, home, trusted: (cwd: string) => cwd === project };
    expect(await updateExtensionSources(undefined, options)).toMatchObject([{ id: "acme.local", scope: "project", directory: local }]);
    expect(await updateExtensionSources("./local", options)).toMatchObject([{ id: "acme.local", scope: "project" }]);
  });

  it("installs a local folder by recording it and reading its manifest", async () => {
    const home = await scratch();
    const project = await scratch();
    const source = await packageFolder(await scratch(), "hello");

    const installed = await installExtensionSource(source, "global", { cwd: project, home });
    expect(installed).toMatchObject({ id: "acme.hello", name: "Hello", version: "1.0.0", scope: "global", directory: source });
    expect(installed.signature).toEqual({ state: "unsigned" });
    expect((await readPackagesFile(packagesFilePath("global", project, home))).sources).toEqual([source]);

    const scan = await listExtensionPackages(project, "/agent", { home, trusted: () => true });
    expect(scan.packages.map((pkg) => [pkg.manifest.id, pkg.installedFrom])).toEqual([["acme.hello", source]]);
  });

  it("writes the project's own packages.json for project scope", async () => {
    const home = await scratch();
    const project = await scratch();
    const source = await packageFolder(await scratch(), "hello");
    await installExtensionSource(source, "project", { cwd: project, home });
    expect((await readPackagesFile(join(project, ".tau", "packages.json"))).sources).toEqual([source]);
    expect((await readPackagesFile(join(home, ".tau", "packages.json"))).sources).toEqual([]);
  });

  it("records a folder inside the project relative to it, and forgets it however it is named", async () => {
    const home = await scratch();
    const project = await scratch();
    const source = await packageFolder(join(project, "kits"), "hello");
    const installed = await installExtensionSource(source, "project", { cwd: project, home });
    expect(installed.source).toBe("./kits/hello");
    // The same folder typed another way is the entry already there, not a second one.
    await installExtensionSource("kits/hello", "project", { cwd: project, home });
    expect((await readPackagesFile(packagesFilePath("project", project, home))).sources).toEqual(["./kits/hello"]);
    const scan = await listExtensionPackages(project, "/agent", { home, trusted: () => true });
    expect(scan.packages.map((pkg) => pkg.manifest.id)).toEqual(["acme.hello"]);
    await expect(removeExtensionSource(source, "project", { cwd: project, home })).resolves.toMatchObject({ removed: true });
    expect((await readPackagesFile(packagesFilePath("project", project, home))).sources).toEqual([]);
  });

  it("keeps packages.json out of Git while it names only folders outside the project", async () => {
    const home = await scratch();
    const project = await scratch();
    execFileSync("git", ["init", "-q", project]);
    const exclude = join(project, ".git", "info", "exclude");
    const before = await readFile(exclude, "utf8").catch(() => "");
    const elsewhere = await packageFolder(await scratch(), "hello");
    await installExtensionSource(elsewhere, "project", { cwd: project, home });
    expect(execFileSync("git", ["-C", project, "status", "--porcelain"], { encoding: "utf8" })).toBe("");

    // A folder in the project is for every clone: Git sees the file again.
    const inside = await packageFolder(join(project, "kits"), "other", { id: "acme.other" });
    await installExtensionSource(inside, "project", { cwd: project, home });
    expect(execFileSync("git", ["-C", project, "status", "--porcelain", "--", ".tau"], { encoding: "utf8" })).toContain(".tau/");
    expect(await readFile(exclude, "utf8")).toBe(before);
  });

  it("refuses a source that is not a package or that escapes its store", async () => {
    const home = await scratch();
    const project = await scratch();
    const empty = await scratch();
    await expect(installExtensionSource(empty, "global", { cwd: project, home })).rejects.toThrow(/not a Tau extension package/u);
    await expect(installExtensionSource(join(empty, "nope"), "global", { cwd: project, home })).rejects.toThrow(/is not a folder/u);
    await expect(installExtensionSource("npm:../../evil", "global", { cwd: project, home })).rejects.toThrow(/not an npm package name/u);
    await expect(installExtensionSource("npm:/etc/passwd", "global", { cwd: project, home })).rejects.toThrow(/not an npm package name/u);
    expect((await readPackagesFile(packagesFilePath("global", project, home))).sources).toEqual([]);
  });

  it("refuses a manifest whose id is a path", async () => {
    const home = await scratch();
    const project = await scratch();
    const source = await packageFolder(await scratch(), "bad", { id: "/etc/passwd" });
    await expect(installExtensionSource(source, "global", { cwd: project, home })).rejects.toThrow(/"id" must look like/u);
  });

  it("lists both scopes and forgets a source on remove without deleting the user's folder", async () => {
    const home = await scratch();
    const project = await scratch();
    const global = await packageFolder(await scratch(), "one", { id: "acme.one" });
    const local = await packageFolder(await scratch(), "two", { id: "acme.two" });
    await installExtensionSource(global, "global", { cwd: project, home });
    await installExtensionSource(local, "project", { cwd: project, home });

    expect((await listExtensionSources({ cwd: project, home })).map((entry) => [entry.scope, entry.id]))
      .toEqual([["global", "acme.one"], ["project", "acme.two"]]);

    const removal = await removeExtensionSource(global, "global", { cwd: project, home });
    expect(removal).toEqual({ source: global, scope: "global", removed: true, deleted: false });
    expect(await readFile(join(global, "tau-extension.json"), "utf8")).toContain("acme.one");
    expect((await listExtensionSources({ cwd: project, home })).map((entry) => entry.id)).toEqual(["acme.two"]);
    await expect(removeExtensionSource(global, "global", { cwd: project, home })).resolves.toMatchObject({ removed: false });
  });

  it("clones a git source into the git store", async () => {
    const home = await scratch();
    const project = await scratch();
    const origin = await packageFolder(await scratch(), "remote", { id: "acme.remote" });
    const bin = await scratch();
    const shim = join(bin, "git");
    // A stand-in for git: `clone --depth 1 -- <url> <dest>` copies the fixture.
    await writeFile(shim, `#!/bin/sh\ncp -R "${origin}" "$6"\n`, "utf8");
    await chmod(shim, 0o755);

    const installed = await installExtensionSource("git:https://example.com/acme/remote.git", "global", {
      cwd: project,
      home,
      findCommand: (name) => (name === "git" ? shim : undefined),
    });
    expect(installed.directory).toBe(join(home, ".tau", "git", "example.com-acme-remote"));
    expect(installed.id).toBe("acme.remote");

    const removal = await removeExtensionSource("git:https://example.com/acme/remote.git", "global", { cwd: project, home });
    expect(removal.deleted).toBe(true);
  });

  it("requires renewed consent for an unsigned update with the same permissions", async () => {
    const home = await scratch();
    const project = await scratch();
    const grants = join(home, "grants.json");
    const source = await packageFolder(await scratch(), "hello", { permissions: ["workspace:read"] });
    const installed = await installExtensionSource(source, "global", { cwd: project, home });
    await grantPackage({ id: "acme.hello", version: "1.0.0", permissions: ["workspace:read"] }, true, grants, await readPackageGrantIdentity(installed.directory, { id: "acme.hello", version: "1.0.0" }, []));

    await packageFolder(await scratch(), "ignored");
    await writeFile(join(source, "tau-extension.json"), JSON.stringify({
      id: "acme.hello", name: "Hello", version: "1.1.0", permissions: ["workspace:read"], host: "./host.ts",
    }));
    const [updated] = await updateExtensionSources(undefined, { cwd: project, home });
    expect(updated).toMatchObject({ id: "acme.hello", version: "1.1.0" });
    expect(installed.version).toBe("1.0.0");

    const file = await readExtensionGrants(grants);
    expect(isPackageGranted({ id: "acme.hello", permissions: ["workspace:read"] }, file.grants, await readPackageGrantIdentity(updated.directory, { id: "acme.hello", version: "1.1.0" }, []))).toBe(false);
    expect(isPackageGranted({ id: "acme.hello", permissions: ["workspace:read", "process"] }, file.grants)).toBe(false);
  });

  it("shows a signed package as signed and refuses to load a tampered one", async () => {
    const home = await scratch();
    const project = await scratch();
    const source = await packageFolder(await scratch(), "hello");
    const keys = generateKeyPairSync("ed25519");
    const publishers = join(home, "trusted.json");
    await mkdir(join(home, ".tau"), { recursive: true });
    await writeFile(publishers, JSON.stringify({
      version: 1,
      publishers: [{ id: "acme", name: "ACME", key: String(keys.publicKey.export({ type: "spki", format: "pem" })) }],
    }));
    const files = await hashPackageFiles(source);
    await writeFile(join(source, SIGNATURE_FILE), JSON.stringify({
      publisher: "acme",
      algorithm: "ed25519",
      signature: sign(null, Buffer.from(signaturePayload("acme.hello", "1.0.0", files), "utf8"), keys.privateKey).toString("base64"),
      files,
    }));

    const installed = await installExtensionSource(source, "global", { cwd: project, home, publishersFilePath: publishers });
    expect(installed.signature).toEqual({ state: "signed", publisher: "acme", publisherName: "ACME" });

    await writeFile(join(source, "host.ts"), "export default { activate() { /* changed */ } }");
    const scan = await listExtensionPackages(project, "/agent", { home, trusted: () => true, publishersFilePath: publishers });
    expect(scan.packages).toEqual([]);
    expect(scan.errors[0]?.message).toMatch(/host\.ts does not match its signed hash/u);
  });

  it("reports a source that is listed but no longer installed", async () => {
    const home = await scratch();
    const project = await scratch();
    const source = await packageFolder(await scratch(), "hello");
    await installExtensionSource(source, "global", { cwd: project, home });
    await rm(source, { recursive: true, force: true });
    const scan = await listExtensionPackages(project, "/agent", { home, trusted: () => true });
    expect(scan.errors[0]?.message).toMatch(/listed in packages\.json but is not installed/u);
  });
});
