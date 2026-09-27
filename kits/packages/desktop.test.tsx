// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionInspection, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { PackagesPage, createExtensionSection, packagesExtension } from "./desktop.js";
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
    const install = screen.getByRole("button", { name: "Install" }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Package source" }), { target: { value: "./ext/hello" } });
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Install for" })).getByRole("radio", { name: "This project only" }));
    fireEvent.click(install);
    await waitFor(() => expect(notify).toHaveBeenCalledWith("installed"));
    expect(invoke).toHaveBeenCalledWith("install", { source: "./ext/hello", scope: "project" });
    expect((screen.getByRole("textbox", { name: "Package source" }) as HTMLInputElement).value).toBe("");
  });

  it("installs on Return, and says under the field why an install failed", async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === "list") return { packages: [] };
      throw new Error("npm could not find @acme/nope.");
    });
    render(<PackagesPage cwd="/project" onNotify={vi.fn()} host={host(invoke)} inspect={async () => inspection([])} />);
    expect(await screen.findByText("No package source is installed")).toBeTruthy();
    const field = screen.getByRole("textbox", { name: "Package source" });
    fireEvent.change(field, { target: { value: "npm:@acme/nope" } });
    fireEvent.submit(screen.getByRole("form", { name: "Install a package" }));
    expect((await screen.findByRole("alert")).textContent).toBe("npm could not find @acme/nope.");
    expect(invoke).toHaveBeenCalledWith("install", { source: "npm:@acme/nope", scope: "global" });
    // The source stays for another try; editing it clears the failure.
    expect((field as HTMLInputElement).value).toBe("npm:@acme/nope");
    fireEvent.change(field, { target: { value: "npm:@acme/hello" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when the package list did not load, and reads it again", async () => {
    let fail = true;
    const invoke = vi.fn(async (command: string) => {
      if (command !== "list") return {};
      if (fail) throw new Error("The host is gone.");
      return { packages: [] };
    });
    render(<PackagesPage cwd="/project" onNotify={vi.fn()} host={host(invoke)} inspect={async () => inspection([])} />);
    expect((await screen.findByRole("alert")).textContent).toContain("The host is gone.");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No package source is installed")).toBeTruthy();
  });

  it("asks before it removes a package from the list", async () => {
    const invoke = vi.fn(async (command: string) => (command === "list"
      ? { packages: [{ source: "npm:@acme/hello", scope: "global", directory: "/x", id: "acme.hello", name: "Hello", signatureLabel: "unsigned" }] }
      : { message: `${command}d` }));
    render(<PackagesPage cwd="/project" onNotify={vi.fn()} host={host(invoke)} inspect={async () => inspection([])} />);
    fireEvent.click(await screen.findByRole("button", { name: "Update Hello" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("update", { source: "npm:@acme/hello" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Remove Hello…" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Remove Hello…" }));
    const dialog = screen.getByRole("dialog", { name: "Remove Hello?" });
    expect(dialog.textContent).toContain("npm:@acme/hello");
    expect(invoke).not.toHaveBeenCalledWith("remove", expect.anything());
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("remove", { source: "npm:@acme/hello", scope: "global" }));
  });

  it("draws each row the settings search lists", async () => {
    const { registry } = createKitHarness(vi.fn(async (_id: string, command: string) => (command === "list" ? { packages: [] } : {})));
    registry.activate(packagesExtension);
    const page = registry.getSettingsPages().find((entry) => entry.id === PACKAGES_SETTINGS_PAGE)!;
    render(<page.Component cwd="/project" onNotify={vi.fn()} />);
    expect(page.rows?.length).toBe(3);
    for (const row of page.rows ?? []) expect(document.getElementById(row.id), row.id).toBeTruthy();
  });

  it("lists the packages a source installed, and leaves the kits Tau ships to Extensions", async () => {
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
    await screen.findByRole("heading", { level: 3, name: /^Hello/u });
    const installed = document.getElementById("setting-packages-installed")!;
    expect(screen.queryByLabelText("Bundled kits")).toBeNull();
    expect(await screen.findByText(/listed under Settings → Extensions/u)).toBeTruthy();
    expect(installed.textContent).toContain("signed by ACME");
    expect(installed.textContent).toContain("signature not trusted");
    expect(installed.textContent).not.toContain("tau.packages");
    // A package still waiting for its grant says so where it is listed.
    expect(within(installed).getByText("Waiting for approval")).toBeTruthy();
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

  it("updates and removes an installed package from its own page, after asking", async () => {
    const invoke = vi.fn(async (command: string) => (command === "list"
      ? { packages: [{ source: "npm:@acme/hello", scope: "global", directory: "/x", id: "acme.hello", name: "Hello", signatureLabel: "unsigned" }] }
      : { message: `${command}d` }));
    const Section = createExtensionSection(host(invoke));
    const notify = vi.fn();
    const changed = vi.fn();
    const { rerender } = render(<Section extensionId="acme.hello" onNotify={notify} onChanged={changed} />);
    expect(await screen.findByText("npm:@acme/hello")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("update", { source: "npm:@acme/hello" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove…" }));
    const dialog = screen.getByRole("dialog", { name: "Remove Hello?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("remove", { source: "npm:@acme/hello", scope: "global" }));
    expect(notify).toHaveBeenCalledWith("removed");
    expect(changed).toHaveBeenCalled();
    // A kit Tau ships has no source to update or remove.
    rerender(<Section extensionId="tau.terminal" onNotify={notify} onChanged={changed} />);
    await waitFor(() => expect(screen.queryByText("npm:@acme/hello")).toBeNull());
  });
});
