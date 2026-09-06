// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionInspection, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { PackagesPage, packagesExtension } from "./desktop.js";
import { PACKAGES_EXTENSION_ID, PACKAGES_SETTINGS_PAGE, parseInstallArguments } from "./protocol.js";

afterEach(cleanup);

const actions = () => ({ notify: vi.fn(), openSettings: vi.fn() } as unknown as WorkbenchActions);

const inspection = (packages: ExtensionInspection["packages"], distribution?: ExtensionInspection["distribution"]): ExtensionInspection => ({
  versions: { tau: "0", pi: "0", api: "1.2.0" }, directories: [], packages, errors: [], skipped: [], ...(distribution ? { distribution } : {}),
});

const host = (invoke: (command: string, input?: unknown) => Promise<unknown>) => ({
  invoke: (command: string, input?: unknown) => invoke(command, input),
  onEvent: () => () => undefined,
});

describe("install arguments", () => {
  it("reads Pi's -l flag out of a slash command's arguments", () => {
    expect(parseInstallArguments("npm:@acme/hello")).toEqual({ source: "npm:@acme/hello", scope: "global" });
    expect(parseInstallArguments("  git:https://example.com/x.git  -l ")).toEqual({ source: "git:https://example.com/x.git", scope: "project" });
    expect(parseInstallArguments("./ext --local")).toEqual({ source: "./ext", scope: "project" });
    expect(parseInstallArguments("")).toEqual({ source: "", scope: "global" });
  });

  it("names the distribution the shipped kits came in", async () => {
    const invoke = vi.fn(async () => ({ packages: [] }));
    render(
      <PackagesPage
        cwd="/project"
        onNotify={vi.fn()}
        host={host(invoke)}
        inspect={async () => inspection(
          [{ id: "tau.packages", name: "Packages", version: "1.0.0", permissions: ["packages"], isolation: "in-process", granted: true, scope: "bundled", directory: "/app/dist-kits/tau.packages", desktop: true, host: true }],
          { name: "@tau/kits", version: "0.1.0" },
        )}
      />,
    );
    expect(await screen.findByText(/@tau\/kits 0\.1\.0/u)).toBeTruthy();
  });
});

describe("Packages kit", () => {
  it("sends /install, /remove and /update to the host half", async () => {
    const invoke = vi.fn(async () => ({ message: "done" }));
    const { registry } = createKitHarness(invoke);
    registry.activate(packagesExtension);

    const install = registry.findSlashCommand("/install npm:@acme/hello -l");
    expect(await install?.command.run(install.args, actions())).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith(PACKAGES_EXTENSION_ID, "install", { source: "npm:@acme/hello", scope: "project" });

    const remove = registry.findSlashCommand("/remove npm:@acme/hello");
    await remove?.command.run(remove.args, actions());
    expect(invoke).toHaveBeenCalledWith(PACKAGES_EXTENSION_ID, "remove", { source: "npm:@acme/hello", scope: "global" });

    const update = registry.findSlashCommand("/update");
    await update?.command.run(update.args, actions());
    expect(invoke).toHaveBeenCalledWith(PACKAGES_EXTENSION_ID, "update", {});
  });

  it("reports a source the user did not name instead of calling the host", async () => {
    const invoke = vi.fn(async () => ({}));
    const { registry } = createKitHarness(invoke);
    registry.activate(packagesExtension);
    const install = registry.findSlashCommand("/install");
    expect(await install?.command.run(install.args, actions())).toMatch(/Name a source/u);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("contributes the Settings page its command opens, and takes it back", () => {
    const { registry } = createKitHarness(vi.fn(async () => ({})));
    registry.activate(packagesExtension);
    expect(registry.getSettingsPages().map((page) => page.id)).toEqual([PACKAGES_SETTINGS_PAGE]);
    const open = registry.getCommands().find((command) => command.id === "packages.install");
    const app = actions();
    open?.run(app);
    expect(app.openSettings).toHaveBeenCalledWith(PACKAGES_SETTINGS_PAGE);
    registry.deactivate(PACKAGES_EXTENSION_ID);
    expect(registry.getSettingsPages()).toEqual([]);
  });

  it("installs from the settings form at the scope the user picked", async () => {
    const invoke = vi.fn(async (command: string) => (command === "list" ? { packages: [] } : { message: "installed" }));
    const notify = vi.fn();
    render(<PackagesPage cwd="/project" onNotify={notify} host={host(invoke)} inspect={async () => inspection([])} />);
    fireEvent.change(screen.getByLabelText("Package source"), { target: { value: "./ext/hello" } });
    fireEvent.click(screen.getByText("This project only"));
    fireEvent.click(screen.getByText("Install"));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("installed"));
    expect(invoke).toHaveBeenCalledWith("install", { source: "./ext/hello", scope: "project" });
  });

  it("lists the kits Tau ships apart from the packages a source installed", async () => {
    const invoke = vi.fn(async (command: string) => command === "list"
      ? {
        packages: [
          { source: "npm:@acme/hello", scope: "global", directory: "/home/.tau/npm/node_modules/@acme/hello", id: "acme.hello", name: "Hello", version: "1.0.0", signatureLabel: "signed by ACME" },
          { source: "/local/ext", scope: "project", directory: "/local/ext", id: "acme.local", name: "Local", signatureLabel: "signature not trusted" },
        ],
      }
      : {});
    render(
      <PackagesPage
        cwd="/project"
        onNotify={vi.fn()}
        host={host(invoke)}
        inspect={async () => inspection([
          { id: "tau.packages", name: "Packages", version: "1.0.0", permissions: ["packages"], isolation: "in-process", granted: true, scope: "bundled", directory: "/app/dist-kits/tau.packages", desktop: true, host: true },
          { id: "acme.hello", name: "Hello", permissions: [], scope: "global", granted: false, directory: "/home/.tau/npm/node_modules/@acme/hello", desktop: true, host: false },
        ])}
      />,
    );
    const kits = await screen.findByLabelText("Bundled kits");
    expect(kits.textContent).toContain("tau.packages");
    expect(kits.textContent).not.toContain("acme.hello");

    const installed = screen.getByLabelText("Installed packages");
    expect(installed.textContent).toContain("signed by ACME");
    expect(installed.textContent).toContain("signature not trusted");
    expect(installed.textContent).not.toContain("tau.packages");
    // A package still waiting for its grant says so where it is listed.
    expect(installed.textContent).toContain("waiting for approval");
  });

  it("names the distribution the shipped kits came in", async () => {
    const invoke = vi.fn(async () => ({ packages: [] }));
    render(
      <PackagesPage
        cwd="/project"
        onNotify={vi.fn()}
        host={host(invoke)}
        inspect={async () => inspection(
          [{ id: "tau.packages", name: "Packages", version: "1.0.0", permissions: ["packages"], isolation: "in-process", granted: true, scope: "bundled", directory: "/app/dist-kits/tau.packages", desktop: true, host: true }],
          { name: "@tau/kits", version: "0.1.0" },
        )}
      />,
    );
    expect(await screen.findByText(/@tau\/kits 0\.1\.0/u)).toBeTruthy();
  });
});
