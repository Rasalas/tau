// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import type { HostUpdateStatus } from "../../shared/host-updates";
import { packLicenses, type ThirdPartyLicense } from "../../shared/third-party-licenses";
import { AboutPage, loadLicenses } from "./AboutPage";
import { settingsSearchEntries } from "./settings-search";

afterEach(cleanup);

const LICENSES: ThirdPartyLicense[] = [
  { name: "react", version: "19.0.0", license: "MIT", repository: "https://github.com/facebook/react", text: "MIT License\n\nCopyright Meta" },
  { name: "highlight.js", version: "11.12.0", license: "BSD-3-Clause" },
];

function renderAbout(loader: () => Promise<ThirdPartyLicense[]>, versions: { host?: string; window?: string } = { host: "0.5.0", window: "0.5.0" }, open = true, status?: HostUpdateStatus) {
  const windowAction = vi.fn(async () => undefined);
  const copyText = vi.fn(async () => undefined);
  const client = createFakeHostClient({ getVersions: () => versions, windowAction, copyText, ...(status ? { hostUpdate: async () => status } : {}) });
  render(<TestProviders><HostClientProvider client={client}><AboutPage loader={loader} /></HostClientProvider></TestProviders>);
  // The list loads once asked for.
  if (open) fireEvent.click(screen.getByRole("button", { name: "Licenses" }));
  return { windowAction, copyText };
}

describe("Settings → About", () => {
  it("lists the licences, filters them and opens a notice", async () => {
    renderAbout(async () => LICENSES);
    expect(await screen.findByText("Open-source licenses (2)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter licenses"), { target: { value: "bsd" } });
    expect(screen.queryByText("react")).toBeNull();
    expect(screen.getByText("highlight.js")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter licenses"), { target: { value: "" } });
    fireEvent.click(screen.getByText("react").closest("button")!);
    expect(screen.getByText(/Copyright Meta/u)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Project source of react" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter licenses"), { target: { value: "nothing" } });
    expect(screen.getByText("No package matches “nothing”")).toBeTruthy();
    // The empty state offers the way back, beside the field's own clear button.
    fireEvent.click(screen.getAllByRole("button", { name: "Clear the filter" }).at(-1)!);
    expect(screen.getByText("react")).toBeTruthy();
  });

  it("says so when the list did not load, and reads it again", async () => {
    let fail = true;
    renderAbout(async () => { if (fail) throw new Error("The list of licenses did not load (404)."); return LICENSES; });
    expect(await screen.findByText("The licenses are not available")).toBeTruthy();
    expect(screen.getByText("The list of licenses did not load (404).")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Open-source licenses (2)")).toBeTruthy();
  });

  it("shows the version, copies diagnostics and loads the licences only when asked", async () => {
    const loader = vi.fn(async () => LICENSES);
    const { copyText } = renderAbout(loader, undefined, false);
    expect(screen.getByText("0.5.0")).toBeTruthy();
    expect(loader).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(expect.stringMatching(/^Tau 0\.5\.0/u)));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Licenses" }));
    expect(await screen.findByText("Open-source licenses (2)")).toBeTruthy();
  });

  it("names both versions when the window and the host differ", () => {
    renderAbout(async () => [], { host: "0.5.0", window: "0.5.1" });
    expect(screen.getByText("0.5.0")).toBeTruthy();
    expect(screen.getByText(/this window 0\.5\.1/u)).toBeTruthy();
  });

  it("offers no update check where there is no window process", async () => {
    renderAbout(async () => [], { host: "0.5.0" });
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: "Check now" })).toBeNull();
  });

  it("has every row the search names for it", async () => {
    renderAbout(async () => LICENSES, undefined, true, { version: "0.5.0", phase: "current", channel: "stable", automatic: true, installer: "host", devicesMayInstall: true });
    await screen.findByText("Open-source licenses (2)");
    await screen.findByRole("switch", { name: "Automatic updates" });
    const rows = settingsSearchEntries({ pages: [], extensions: [] }).filter((entry) => entry.page === "about" && entry.target);
    expect(rows.length).toBe(5);
    for (const row of rows) expect(document.getElementById(row.target!), row.label).not.toBeNull();
  });

  it("reads the manifest beside the page", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(packLicenses(LICENSES))));
    expect(await loadLicenses(fetchImpl as unknown as typeof fetch, "file:///app/dist/index.html")).toEqual(LICENSES);
    expect(fetchImpl).toHaveBeenCalledWith("file:///app/dist/third-party-licenses.json");
  });
});
