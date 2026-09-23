// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { packLicenses, type ThirdPartyLicense } from "../../shared/third-party-licenses";
import { AboutPage, loadLicenses } from "./AboutPage";

afterEach(cleanup);

const LICENSES: ThirdPartyLicense[] = [
  { name: "react", version: "19.0.0", license: "MIT", repository: "https://github.com/facebook/react", text: "MIT License\n\nCopyright Meta" },
  { name: "highlight.js", version: "11.12.0", license: "BSD-3-Clause" },
];

function renderAbout(loader: () => Promise<ThirdPartyLicense[]>, versions: { host?: string; window?: string } = { host: "0.5.0", window: "0.5.0" }) {
  const windowAction = vi.fn(async () => undefined);
  const client = createFakeHostClient({ getVersions: () => versions, windowAction });
  render(<TestProviders><HostClientProvider client={client}><AboutPage loader={loader} /></HostClientProvider></TestProviders>);
  return { windowAction };
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
  });

  it("says so when the list did not load", async () => {
    renderAbout(async () => { throw new Error("The list of licenses did not load (404)."); });
    expect(await screen.findByText("The licenses are not available")).toBeTruthy();
    expect(screen.getByText("The list of licenses did not load (404).")).toBeTruthy();
  });

  it("shows the version and asks the window's process to check for updates", async () => {
    const { windowAction } = renderAbout(async () => []);
    expect(screen.getByText("0.5.0")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check for Updates…" }));
    await waitFor(() => expect(windowAction).toHaveBeenCalledWith({ kind: "check-for-updates" }));
  });

  it("offers no update check where there is no window process", () => {
    renderAbout(async () => [], { host: "0.5.0" });
    expect(screen.queryByRole("button", { name: "Check for Updates…" })).toBeNull();
  });

  it("reads the manifest beside the page", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(packLicenses(LICENSES))));
    expect(await loadLicenses(fetchImpl as unknown as typeof fetch, "file:///app/dist/index.html")).toEqual(LICENSES);
    expect(fetchImpl).toHaveBeenCalledWith("file:///app/dist/third-party-licenses.json");
  });
});
