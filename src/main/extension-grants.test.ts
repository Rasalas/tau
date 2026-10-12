import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { confirmExtensionGrant, defaultGrantsFilePath, grantPackage, isPackageGranted, readExtensionGrants, writeExtensionGrants } from "./extension-grants.js";

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
      { id: "acme.one", version: "1.0.0", permissions: ["process", "sessions"], grantedAt: 100 },
      { id: "acme.empty", version: "1.0.0", permissions: [], grantedAt: 200 },
    ];
    // Exact match
    expect(isPackageGranted({ id: "acme.one", permissions: ["sessions", "process"] }, grants)).toBe(true);
    // Missing permission in grant
    expect(isPackageGranted({ id: "acme.one", permissions: ["sessions", "process", "network"] }, grants)).toBe(false);
    // Reduced permissions also requires re-grant (or set changed)
    expect(isPackageGranted({ id: "acme.one", permissions: ["sessions"] }, grants)).toBe(false);
    // Empty permissions granted
    expect(isPackageGranted({ id: "acme.empty", permissions: [] }, grants)).toBe(true);
    expect(isPackageGranted({ id: "acme.empty" }, grants)).toBe(true);
    // Unknown package
    expect(isPackageGranted({ id: "acme.other", permissions: [] }, grants)).toBe(false);
  });

  it("grants and revokes a package", async () => {
    const dir = await scratch();
    const file = join(dir, "grants.json");
    await grantPackage({ id: "acme.one", version: "1.0.0", permissions: ["sessions"] }, true, file);
    let current = await readExtensionGrants(file);
    expect(isPackageGranted({ id: "acme.one", permissions: ["sessions"] }, current.grants)).toBe(true);

    // Revoke
    await grantPackage({ id: "acme.one" }, false, file);
    current = await readExtensionGrants(file);
    expect(isPackageGranted({ id: "acme.one", permissions: ["sessions"] }, current.grants)).toBe(false);
  });
});
