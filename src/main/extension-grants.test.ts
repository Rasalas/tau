import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { confirmExtensionGrant, defaultGrantsFilePath, grantPackage, isPackageGranted, readExtensionGrants, writeExtensionGrants } from "./extension-grants.js";

const identity = { contentHash: "approved-code" };
const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-grants-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("extension-grants", () => {
  it("shows privileges in a native prompt that defaults to cancellation", async () => {
    const pkg = { id: "acme.one", name: "One", directory: "/packages/one", scope: "global" as const, desktop: true, host: true, permissions: ["native"], isolation: "in-process" as const };
    const prompts: Array<Parameters<Parameters<typeof confirmExtensionGrant>[1]>[0]> = [];
    expect(await confirmExtensionGrant(pkg, async (prompt) => { prompts.push(prompt); return { response: 0 }; })).toBe(false);
    expect(prompts[0]).toMatchObject({ defaultId: 0, cancelId: 0, buttons: ["Cancel", "Allow"] });
    expect(prompts[0]?.detail).toContain("acme.one");
    expect(prompts[0]?.detail).toContain("Permissions: native");
    expect(prompts[0]?.detail).toContain("Isolation: in-process");
    expect(await confirmExtensionGrant(pkg, async () => ({ response: 1 }))).toBe(true);
  });
  it.each([[], ["network"], ["process"], ["native"]].map((permissions) => ({ permissions })))("explains worker file access for $permissions", async ({ permissions }) => {
    const pkg = { id: "acme.worker", name: "Worker", directory: "/packages/worker", scope: "global" as const, desktop: false, host: true, permissions, isolation: "worker" as const };
    await confirmExtensionGrant(pkg, async (prompt) => {
      expect(prompt.detail).toContain("It runs in a process of its own: it reads its own files, writes only to its own data folder, and cannot reach the network, start programs or load compiled code without the matching permission.");
      expect(prompt.detail.includes("With the permission to start programs or load compiled code it could get around these limits.")).toBe(permissions.includes("process") || permissions.includes("native"));
      expect(prompt.detail).not.toMatch(/OS sandbox|\bNode\b|Bundled kits/);
      return { response: 0 };
    });
  });
  it("lives in ~/.tau unless TAU_EXTENSION_GRANTS_FILE names another file", () => {
    expect(defaultGrantsFilePath("/home/me", {})).toBe(join("/home/me", ".tau", "extension-grants.json"));
    expect(defaultGrantsFilePath("/home/me", { TAU_EXTENSION_GRANTS_FILE: "/dev/tau/grants.json" })).toBe("/dev/tau/grants.json");
  });


  it("reads empty grants when file does not exist", async () => {
    const dir = await scratch();
    const file = join(dir, "grants.json");
    const result = await readExtensionGrants(file);
    expect(result).toEqual({ grants: [] });
  });

  it("writes and reads back grants", async () => {
    const dir = await scratch();
    const file = join(dir, "grants.json");
    await writeExtensionGrants({
      grants: [{ id: "acme.one", version: "1.0.0", permissions: ["workspace:read"], grantedAt: 12345 }],
    }, file);
    const result = await readExtensionGrants(file);
    expect(result.grants).toHaveLength(1);
    expect(result.grants[0].id).toBe("acme.one");
    expect(result.grants[0].permissions).toEqual(["workspace:read"]);
  });

  it("checks whether a package is granted based on requested permissions", () => {
    const grants = [
      { id: "acme.one", version: "1.0.0", permissions: ["process", "sessions"], contentHash: identity.contentHash, grantedAt: 100 },
      { id: "acme.empty", version: "1.0.0", permissions: [], contentHash: identity.contentHash, grantedAt: 200 },
    ];
    // Exact match
    expect(isPackageGranted({ id: "acme.one", permissions: ["sessions", "process"] }, grants, identity)).toBe(true);
    // Missing permission in grant
    expect(isPackageGranted({ id: "acme.one", permissions: ["sessions", "process", "network"] }, grants, identity)).toBe(false);
    // Reduced permissions also requires re-grant (or set changed)
    expect(isPackageGranted({ id: "acme.one", permissions: ["sessions"] }, grants, identity)).toBe(false);
    // Empty permissions granted
    expect(isPackageGranted({ id: "acme.empty", permissions: [] }, grants, identity)).toBe(true);
    expect(isPackageGranted({ id: "acme.empty" }, grants, identity)).toBe(true);
    // Unknown package
    expect(isPackageGranted({ id: "acme.other", permissions: [] }, grants, identity)).toBe(false);
  });

  it("grants and revokes a package", async () => {
    const dir = await scratch();
    const file = join(dir, "grants.json");
    await grantPackage({ id: "acme.one", version: "1.0.0", permissions: ["sessions"] }, true, file, identity);
    let current = await readExtensionGrants(file);
    expect(isPackageGranted({ id: "acme.one", permissions: ["sessions"] }, current.grants, identity)).toBe(true);

    // Revoke
    await grantPackage({ id: "acme.one" }, false, file);
    current = await readExtensionGrants(file);
    expect(isPackageGranted({ id: "acme.one", permissions: ["sessions"] }, current.grants, identity)).toBe(false);
  });
});
