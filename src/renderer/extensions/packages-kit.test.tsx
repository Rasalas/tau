// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "../host-client";
import { HostClientProvider } from "../host-client-context";
import { ExtensionRegistry, type WorkbenchActions } from "../extension-system";
import { PackagesPage } from "../components/PackagesPage";
import { PACKAGES_EXTENSION_ID, packagesExtension, parseInstallArguments } from "./packages-kit";

afterEach(cleanup);

function fakeClient(overrides: Partial<HostClient> = {}): HostClient {
  return {
    invokeHostExtension: vi.fn(async () => ({ packages: [] })),
    inspectExtensions: vi.fn(async () => ({ versions: { tau: "0", pi: "0", api: "1" }, directories: [], packages: [], errors: [], skipped: [] })),
    onHostEvent: () => () => undefined,
    ...overrides,
  } as unknown as HostClient;
}

const actions = () => ({ notify: vi.fn(), openSettings: vi.fn() } as unknown as WorkbenchActions);

describe("Packages kit", () => {
  it("reads Pi's -l flag out of a slash command's arguments", () => {
    expect(parseInstallArguments("npm:@acme/hello")).toEqual({ source: "npm:@acme/hello", scope: "global" });
    expect(parseInstallArguments("  git:https://example.com/x.git  -l ")).toEqual({ source: "git:https://example.com/x.git", scope: "project" });
    expect(parseInstallArguments("./ext --local")).toEqual({ source: "./ext", scope: "project" });
    expect(parseInstallArguments("")).toEqual({ source: "", scope: "global" });
  });

  it("sends /install, /remove and /update to the host half", async () => {
    const invoke = vi.fn(async (_id: string, _command: string, _input?: unknown) => ({ message: "done" }));
    const registry = new ExtensionRegistry({ invoke });
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
    const invoke = vi.fn(async (_id: string, _command: string, _input?: unknown) => ({}));
    const registry = new ExtensionRegistry({ invoke });
    registry.activate(packagesExtension);
    const install = registry.findSlashCommand("/install");
    expect(await install?.command.run(install.args, actions())).toMatch(/Name a source/u);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("installs from the settings form at the scope the user picked", async () => {
    const invoke = vi.fn(async (_id: string, command: string) => (command === "list" ? { packages: [] } : { message: "installed" }));
    const notify = vi.fn();
    render(
      <HostClientProvider client={fakeClient({ invokeHostExtension: invoke as unknown as HostClient["invokeHostExtension"] })}>
        <PackagesPage cwd="/project" onNotify={notify} />
      </HostClientProvider>,
    );
    fireEvent.change(screen.getByLabelText("Package source"), { target: { value: "./ext/hello" } });
    fireEvent.click(screen.getByText("This project only"));
    fireEvent.click(screen.getByText("Install"));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("installed"));
    expect(invoke).toHaveBeenCalledWith(PACKAGES_EXTENSION_ID, "install", { source: "./ext/hello", scope: "project" });
  });

  it("shows what a listed package is signed with", async () => {
    const invoke = vi.fn(async (_id: string, command: string) => command === "list"
      ? {
        packages: [
          { source: "npm:@acme/hello", scope: "global", directory: "/home/.tau/npm/node_modules/@acme/hello", id: "acme.hello", name: "Hello", version: "1.0.0", signature: { state: "signed", publisher: "acme", publisherName: "ACME" } },
          { source: "/local/ext", scope: "project", directory: "/local/ext", id: "acme.local", name: "Local", signature: { state: "untrusted", publisher: "who" } },
        ],
      }
      : {});
    render(
      <HostClientProvider client={fakeClient({ invokeHostExtension: invoke as unknown as HostClient["invokeHostExtension"] })}>
        <PackagesPage cwd="/project" onNotify={vi.fn()} />
      </HostClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("signed by ACME")).toBeTruthy());
    expect(screen.getByText("signature not trusted")).toBeTruthy();
    expect(screen.getByText("npm:@acme/hello")).toBeTruthy();
  });
});
