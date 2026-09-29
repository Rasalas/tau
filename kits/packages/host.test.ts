import { describe, expect, it, vi } from "vitest";
import { HostCommandError, type HostExtensionServices, type InstalledPackage } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createPackagesHostExtension, describeInstalled } from "./host.js";
import { PACKAGES_EXTENSION_ID } from "./protocol.js";

const hello: InstalledPackage = {
  source: "/src/hello",
  scope: "project",
  directory: "/src/hello",
  id: "acme.hello",
  name: "Hello",
  version: "1.0.0",
  signature: { state: "unsigned" },
  signatureLabel: "unsigned",
};

function installer(overrides: Partial<HostExtensionServices> = {}) {
  return {
    listPackages: vi.fn(async () => [hello]),
    installPackage: vi.fn(async () => hello),
    removePackage: vi.fn(async () => ({ source: hello.source, scope: "project" as const, removed: true, deleted: false })),
    updatePackages: vi.fn(async () => [hello]),
    refreshExtensionPackages: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("Packages host extension", () => {
  it("registers install, remove, update and list, with the long ones as jobs", async () => {
    const registry = await activateHostKit(createPackagesHostExtension(), installer());
    const summary = registry.summaries().find((entry) => entry.id === PACKAGES_EXTENSION_ID);
    expect(summary?.commands).toEqual(["builds", "install", "list", "rebuild", "remove", "trust", "update"]);
    // A client runs these off the request path, so a clone or an npm install can report progress.
    expect(registry.longCommands()).toContain(`${PACKAGES_EXTENSION_ID}/install`);
    expect(registry.longCommands()).toContain(`${PACKAGES_EXTENSION_ID}/update`);
    expect(registry.longCommands()).not.toContain(`${PACKAGES_EXTENSION_ID}/list`);
  });

  it("installs through the host's installer and rescans, so no reload is needed", async () => {
    const services = installer();
    const registry = await activateHostKit(createPackagesHostExtension(), services);

    const installed = await registry.invoke(PACKAGES_EXTENSION_ID, "install", { source: "/src/hello", scope: "project" }) as { message: string };
    expect(services.installPackage).toHaveBeenCalledWith("/src/hello", "project", expect.any(Function));
    expect(services.refreshExtensionPackages).toHaveBeenCalledTimes(1);
    expect(installed.message).toContain("approve it in Settings → Extensions to start it");
    expect(installed.message).not.toContain("/reload");

    const listed = await registry.invoke(PACKAGES_EXTENSION_ID, "list") as { packages: Array<{ id?: string; signatureLabel: string }> };
    expect(listed.packages).toEqual([{
      source: "/src/hello", scope: "project", directory: "/src/hello", id: "acme.hello", name: "Hello", version: "1.0.0", signatureLabel: "unsigned",
    }]);

    const removed = await registry.invoke(PACKAGES_EXTENSION_ID, "remove", { source: "/src/hello", scope: "project" }) as { message: string };
    expect(removed.message).toBe("Removed /src/hello.");
    expect(services.refreshExtensionPackages).toHaveBeenCalledTimes(2);

    const updated = await registry.invoke(PACKAGES_EXTENSION_ID, "update", {}) as { message: string };
    expect(services.updatePackages).toHaveBeenCalledWith(undefined, expect.any(Function));
    expect(services.refreshExtensionPackages).toHaveBeenCalledTimes(3);
    expect(updated.message).toBe("1 of 1 updated and re-activated.");
  });

  it("says a project install is skipped while Pi does not trust the project, and trusts it through Pi's store", async () => {
    const trusted = new Set<string>();
    const projectTrust = {
      trusted: vi.fn((cwd = "/project") => trusted.has(cwd)),
      trust: vi.fn((cwd = "/project") => { trusted.add(cwd); return cwd; }),
    };
    const services = installer({ projectTrust });
    const registry = await activateHostKit(createPackagesHostExtension(), services);

    const skipped = await registry.invoke(PACKAGES_EXTENSION_ID, "install", { source: "/src/hello", scope: "project" }) as { message: string; untrusted?: boolean };
    expect(skipped.untrusted).toBe(true);
    expect(skipped.message).toMatch(/skipped: Pi does not trust this project/u);
    expect(skipped.message).toMatch(/Settings → Packages/u);

    const answer = await registry.invoke(PACKAGES_EXTENSION_ID, "trust", { cwd: "/project" }) as { message: string };
    expect(projectTrust.trust).toHaveBeenCalledWith("/project");
    expect(answer.message).toMatch(/Pi trusts \/project now/u);
    // Trusting is what makes the project's packages load, so the host rescans at once.
    expect(services.refreshExtensionPackages).toHaveBeenCalledTimes(2);

    const loaded = await registry.invoke(PACKAGES_EXTENSION_ID, "install", { source: "/src/hello", scope: "project" }) as { untrusted?: boolean };
    expect(loaded.untrusted).toBeUndefined();
    // A global install needs no trust at all.
    trusted.clear();
    expect((await registry.invoke(PACKAGES_EXTENSION_ID, "install", { source: "/src/hello" }) as { untrusted?: boolean }).untrusted).toBeUndefined();
  });

  it("answers the last builds and passes each new one on to the page", async () => {
    let observer: ((build: unknown) => void) | undefined;
    const build = { id: "me.kit", directory: "/k", half: "desktop" as const, entry: "/k/desktop.tsx", at: 1, ok: true };
    const services = installer({ packageBuilds: { list: () => [build], observe: (listener) => { observer = listener as never; return () => { observer = undefined; }; } } });
    const registry = await activateHostKit(createPackagesHostExtension(), services);
    expect(await registry.invoke(PACKAGES_EXTENSION_ID, "builds")).toEqual({ builds: [build] });
    expect(observer).toBeDefined();
    await registry.invoke(PACKAGES_EXTENSION_ID, "rebuild");
    expect(services.refreshExtensionPackages).toHaveBeenCalledTimes(1);
  });

  it("refuses to trust a relative path", async () => {
    const registry = await activateHostKit(createPackagesHostExtension(), installer({ projectTrust: { trusted: () => false, trust: vi.fn(() => "/x") } }));
    await expect(registry.invoke(PACKAGES_EXTENSION_ID, "trust", { cwd: "project" })).rejects.toThrow(/absolute path/u);
  });

  it("reports a rescan that failed instead of failing the install", async () => {
    const log = vi.fn();
    const services = installer({ refreshExtensionPackages: vi.fn(async () => { throw new Error("scan is busy"); }) });
    const registry = await activateHostKit(createPackagesHostExtension(), { ...services, log });
    await expect(registry.invoke(PACKAGES_EXTENSION_ID, "install", { source: "/src/hello" })).resolves.toBeDefined();
    expect(log).toHaveBeenCalledWith("packages.rescan.failed", "scan is busy");
  });

  // A path that is not a package is the user's typo, not a broken command: three
  // of them in a row must not deactivate the one extension that can install.
  it("answers bad input with an expected error the registry does not count", async () => {
    const registry = await activateHostKit(createPackagesHostExtension(), installer({
      installPackage: vi.fn(async () => { throw new HostCommandError("/nope is not a folder."); }),
    }));
    await expect(registry.invoke(PACKAGES_EXTENSION_ID, "install", {})).rejects.toThrow(/Name a source/u);
    await expect(registry.invoke(PACKAGES_EXTENSION_ID, "install", { source: "npm:x", scope: "world" })).rejects.toThrow(/"scope" is/u);
    await expect(registry.invoke(PACKAGES_EXTENSION_ID, "install", { source: "/nope" })).rejects.toThrow(/is not a folder/u);
    await expect(registry.invoke(PACKAGES_EXTENSION_ID, "install", { source: "/nope" })).rejects.toThrow(/is not a folder/u);
    expect(registry.isActive(PACKAGES_EXTENSION_ID)).toBe(true);
    expect(registry.summaries().find((entry) => entry.id === PACKAGES_EXTENSION_ID)?.error).toBeUndefined();
  });

  it("refuses to remove a source packages.json does not list", async () => {
    const registry = await activateHostKit(createPackagesHostExtension(), installer({
      removePackage: vi.fn(async () => ({ source: "/src/hello", scope: "global" as const, removed: false, deleted: false })),
    }));
    await expect(registry.invoke(PACKAGES_EXTENSION_ID, "remove", { source: "/src/hello" }))
      .rejects.toThrow(/is not listed in the global packages.json/u);
  });

  it("prints a package the way `pi list` does", () => {
    expect(describeInstalled({ source: "/src/hello", scope: "project", directory: "/src/hello", id: "acme.hello", version: "1.0.0", signatureLabel: "unsigned" }))
      .toBe("acme.hello 1.0.0 · project · unsigned");
  });
});
