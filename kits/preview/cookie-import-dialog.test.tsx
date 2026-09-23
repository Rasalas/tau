// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { RegionProps } from "tau";
import { CookieImportDialogs, createCookieImportLayer, filterSites, formatSites, readFailure } from "./cookie-import-dialog.js";
import type { CookieImportResult, PreviewHostClient } from "./protocol.js";

afterEach(cleanup);

function fakeClient(options: { failImport?: string } = {}) {
  const calls: Array<{ command: string; input?: unknown }> = [];
  const record = (command: string, answer: (input?: unknown) => unknown) => async (input?: unknown) => {
    calls.push({ command, ...(input === undefined ? {} : { input }) });
    return answer(input);
  };
  const client = {
    "import-sources": record("import-sources", () => [
      { id: "chrome", name: "Chrome", engine: "chromium", keychain: "Chrome Safe Storage", profiles: [{ id: "Default", name: "Person 1" }, { id: "Profile 1", name: "Work" }] },
      { id: "firefox", name: "Firefox", engine: "firefox", profiles: [{ id: "Profiles/a", name: "default-release" }] },
    ]),
    profiles: record("profiles", () => ({ profiles: ["default", "work"], active: "default" })),
    "import-sites": record("import-sites", () => [{ site: "github.com", cookies: 2 }, { site: "google.com", cookies: 5 }, { site: "localhost", cookies: 1 }]),
    "import-cookies": record("import-cookies", () => {
      if (options.failImport) throw new Error(options.failImport);
      return { imported: 2, skipped: 0, skippedSites: [], profile: "work", reloaded: false } satisfies CookieImportResult;
    }),
    "import-open-access": record("import-open-access", () => undefined),
  } as unknown as PreviewHostClient;
  return { client, calls };
}

function mount(client: PreviewHostClient) {
  const dialogs = new CookieImportDialogs();
  const Layer = createCookieImportLayer(dialogs, client);
  render(<Layer {...({} as RegionProps)} />);
  return dialogs;
}

describe("the cookie import dialog", () => {
  it("reads nothing of a browser before it is chosen, and decrypts nothing before Import", async () => {
    const { client, calls } = fakeClient();
    const dialogs = mount(client);
    let result: Promise<CookieImportResult | undefined> | undefined;
    act(() => { result = dialogs.open({ site: "accounts.github.com", profile: "work" }); });
    const browser = await screen.findByLabelText("Browser");
    await waitFor(() => expect(screen.getByRole("option", { name: "Chrome" })).toBeTruthy());
    expect(calls.map(({ command }) => command).sort()).toEqual(["import-sources", "profiles"]);

    fireEvent.change(browser, { target: { value: "chrome" } });
    await screen.findByText("github.com");
    expect(calls.find(({ command }) => command === "import-sites")?.input).toEqual({ source: "chrome", profile: "Default" });
    // The site the caller named is filtered to and chosen.
    expect((screen.getByLabelText("Filter sites") as HTMLInputElement).value).toBe("accounts.github.com");
    expect(screen.queryByText("google.com")).toBeNull();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Choose Allow, not Always Allow/u)).toBeTruthy();
    expect(calls.some(({ command }) => command === "import-cookies")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText("Imported 2 cookies");
    expect(calls.find(({ command }) => command === "import-cookies")?.input).toEqual({ source: "chrome", profile: "Default", sites: ["github.com"], into: "work" });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await expect(result).resolves.toMatchObject({ imported: 2, profile: "work" });
  });

  it("imports nothing without a chosen site, and resolves with nothing when cancelled", async () => {
    const { client, calls } = fakeClient();
    const dialogs = mount(client);
    let result: Promise<CookieImportResult | undefined> | undefined;
    act(() => { result = dialogs.open(); });
    await waitFor(() => expect(screen.getByRole("option", { name: "Firefox" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Browser"), { target: { value: "firefox" } });
    await screen.findByText("google.com");
    expect((screen.getByRole("button", { name: "Import" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/keychain/u)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(result).resolves.toBeUndefined();
    expect(calls.some(({ command }) => command === "import-cookies")).toBe(false);
  });

  it("offers another try after the keychain said no", async () => {
    const { client, calls } = fakeClient({ failImport: "[keychain-denied] The keychain did not hand out \"Chrome Safe Storage\"." });
    const dialogs = mount(client);
    act(() => { void dialogs.open({ site: "localhost" }); });
    await waitFor(() => expect(screen.getByRole("option", { name: "Chrome" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Browser"), { target: { value: "chrome" } });
    await screen.findByText("localhost");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText(/did not hand out/u);
    expect(screen.queryByText(/^\[keychain-denied\]/u)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(calls.filter(({ command }) => command === "import-cookies")).toHaveLength(2));
  });
});

describe("its pieces", () => {
  it("filters sites, the named site's own first", () => {
    const sites = [{ site: "example.com", cookies: 1 }, { site: "github.com", cookies: 2 }, { site: "githubstatus.com", cookies: 1 }];
    expect(filterSites(sites, "").map(({ site }) => site)).toEqual(["example.com", "github.com", "githubstatus.com"]);
    expect(filterSites(sites, "github").map(({ site }) => site)).toEqual(["github.com", "githubstatus.com"]);
    expect(filterSites(sites, "api.github.com").map(({ site }) => site)).toEqual(["github.com"]);
  });

  it("names skipped sites briefly and reads a failure's reason", () => {
    expect(formatSites(["a.com"])).toBe("a.com");
    expect(formatSites(["a.com", "b.com"])).toBe("a.com and b.com");
    expect(formatSites(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
    expect(readFailure(new Error("[full-disk-access] Tau needs Full Disk Access."))).toEqual({ reason: "full-disk-access", text: "Tau needs Full Disk Access." });
    expect(readFailure(new Error("plain"))).toEqual({ text: "plain" });
  });
});
