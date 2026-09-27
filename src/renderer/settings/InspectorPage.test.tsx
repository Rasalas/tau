// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionInspection } from "../../shared/contracts";
import { ExtensionRegistry } from "../extension-system";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { InspectorPage } from "./InspectorPage";
import { settingsSearchEntries } from "./settings-search";

afterEach(cleanup);

const INSPECTION: ExtensionInspection = {
  versions: { tau: "0.7.5", pi: "0.85.1", api: "1.18.0" },
  directories: [{ scope: "global", directory: "/home/me/.tau/extensions" }],
  packages: [],
  errors: [{ path: "/home/me/.tau/extensions/old", message: "needs api ^9.0.0", incompatible: true }],
  skipped: [],
};

function renderInspector({ cwd = "/project", inspect = async () => INSPECTION }: { cwd?: string | undefined; inspect?: () => Promise<ExtensionInspection> } = {}) {
  const registry = new ExtensionRegistry();
  registry.activate({ id: "acme.fixture", name: "Fixture", activate(context) {
    context.registerCommand({ id: "fixture.run", label: "Run", group: "Fixture", run() {} });
  } });
  const client = createFakeHostClient({
    inspectExtensions: inspect,
    listHostExtensions: async () => [{ id: "acme.fixture", name: "Fixture", active: false, commands: [], error: "boom at start" }],
  });
  render(<TestProviders><HostClientProvider client={client}><InspectorPage registry={registry} {...(cwd ? { cwd } : {})} /></HostClientProvider></TestProviders>);
}

describe("Settings → Inspector", () => {
  it("lists the versions with a copy button, each half's state and what did not load", async () => {
    renderInspector();
    expect(await screen.findByText("0.85.1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy Extension API" })).toBeTruthy();

    const row = document.querySelector('tr[data-extension-id="acme.fixture"]') as HTMLElement;
    expect(within(row).getByText("Active")).toBeTruthy();
    expect(await within(row).findByText("Failed")).toBeTruthy();
    expect(within(row).getByText("boom at start")).toBeTruthy();

    expect(screen.getByText("Incompatible")).toBeTruthy();
    expect(screen.getByText("No package installed")).toBeTruthy();
  });

  it("says so when the scan fails and scans again", async () => {
    let fail = true;
    renderInspector({ inspect: async () => { if (fail) throw new Error("permission denied"); return INSPECTION; } });
    expect(await screen.findByText("The package folders were not scanned")).toBeTruthy();
    expect(screen.getByText("permission denied")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("0.7.5")).toBeTruthy();
  });

  it("asks for a project before it scans", () => {
    renderInspector({ cwd: "" });
    expect(screen.getAllByText("No project open").length).toBeGreaterThan(0);
  });

  it("has every row the search names for it", async () => {
    renderInspector();
    await screen.findByText("0.7.5");
    const rows = settingsSearchEntries({ pages: [], extensions: [] }).filter((entry) => entry.page === "inspector" && entry.target);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(document.getElementById(row.target!), row.label).not.toBeNull();
  });
});
