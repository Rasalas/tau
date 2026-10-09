import { describe, expect, it } from "vitest";
import type { ExtensionPackageSummary } from "../../shared/contracts";
import { extensionBlurb, extensionCatalog, filterCounts, matchesFilter, matchesQuery, stateLabel } from "./extension-catalog";

const pkg = (id: string, overrides: Partial<ExtensionPackageSummary> = {}): ExtensionPackageSummary => ({
  id, name: id, scope: "bundled", directory: `/kits/${id}`, desktop: true, host: false, granted: true, permissions: [], ...overrides,
});

describe("the extension catalog", () => {
  const entries = extensionCatalog({
    summaries: [
      { id: "tau.terminal", name: "Terminal", active: true, contributes: "terminal · settings page", options: [] },
      { id: "tau.review", name: "Review Kit", active: false, contributes: "review", options: [] },
      { id: "tau.runtime", name: "Runtime Controls", active: true, contributes: "commands", options: [], core: true },
    ],
    packages: [
      pkg("tau.terminal", { description: "A shell beside the chat.", version: "1.0.0" }),
      pkg("tau.review"),
      pkg("acme.waiting", { scope: "global", granted: false, host: true, desktop: false }),
      pkg("acme.broken", { scope: "project" }),
    ],
    hostHalves: [{ id: "acme.broken", name: "Broken", active: false, commands: [], error: "boom" }],
    errors: [
      { path: "/x/tau-extension.json", message: "acme.old needs extension API ^9.0.0", id: "acme.old", name: "Old", incompatible: true },
      { path: "/y/tau-extension.json", message: "not valid JSON" },
    ],
  });
  const byId = (id: string) => entries.find((entry) => entry.id === id)!;

  it("marks a kit this device's app is too old for as arriving with the next update, not as needing attention", () => {
    const later = extensionCatalog({
      summaries: [],
      packages: [pkg("tau.resume-compaction", { engines: { api: "^1.53.0" } }), pkg("tau.terminal", { engines: { api: "^1.0.0" } })],
      hostHalves: [{ id: "tau.resume-compaction", name: "Resume Compaction", active: true, commands: [] }],
      api: "1.52.0",
    });
    const entry = later.find((candidate) => candidate.id === "tau.resume-compaction")!;
    expect(entry).toMatchObject({ state: "update", problem: expect.stringContaining("next update") });
    expect(matchesFilter(entry, "attention")).toBe(false);
    expect(stateLabel("update")).toBe("With the next app update");
    expect(later.find((candidate) => candidate.id === "tau.terminal")?.state).not.toBe("update");
  });

  it("gives each extension its state from the three sources", () => {
    expect(byId("tau.terminal")).toMatchObject({ state: "on", origin: "bundled", version: "1.0.0", description: "A shell beside the chat." });
    expect(byId("tau.review")).toMatchObject({ state: "off", origin: "bundled" });
    expect(byId("tau.runtime")).toMatchObject({ state: "on", origin: "app", locked: true });
    expect(byId("acme.waiting")).toMatchObject({ state: "waiting", origin: "installed" });
    expect(byId("acme.broken")).toMatchObject({ state: "failed", problem: "boom" });
    expect(byId("acme.old")).toMatchObject({ state: "incompatible", name: "Old", origin: "installed" });
    // A folder whose manifest named nothing stays the Inspector's.
    expect(entries).toHaveLength(6);
  });

  it("lists a package Pi's project trust kept off, as needing attention", () => {
    const skipped = extensionCatalog({
      summaries: [],
      skipped: [{ directory: "/p/.tau", reason: "not trusted", untrustedProject: "/p", packages: [{ id: "me.kit", name: "My kit", directory: "/k" }] }],
    });
    expect(skipped).toEqual([expect.objectContaining({ id: "me.kit", name: "My kit", state: "skipped", origin: "installed", problem: expect.stringContaining("/p") })]);
    expect(matchesFilter(skipped[0]!, "attention")).toBe(true);
  });

  it("reports a command timeout as a failure without claiming startup failed", () => {
    const reason = 'command "state" timed out after 30000ms';
    const [entry] = extensionCatalog({
      summaries: [{ id: "tau.onboarding", name: "Onboarding", active: true, contributes: "welcome", options: [] }],
      hostHalves: [{ id: "tau.onboarding", name: "Onboarding", active: false, commands: [], error: reason }],
    });
    expect(entry).toMatchObject({ state: "failed", problem: reason });
    expect(matchesFilter(entry!, "attention")).toBe(true);
    expect(stateLabel(entry!.state)).toBe("Failed");
  });

  it("filters and counts by source, by off and by what needs attention", () => {
    expect(filterCounts(entries)).toEqual({ all: 6, bundled: 3, installed: 3, off: 1, attention: 3 });
    expect(entries.filter((entry) => matchesFilter(entry, "attention")).map((entry) => entry.id)).toEqual(["acme.broken", "acme.waiting", "acme.old"]);
  });

  it("finds by name, id, description and what it adds", () => {
    expect(entries.filter((entry) => matchesQuery(entry, "shell chat")).map((entry) => entry.id)).toEqual(["tau.terminal"]);
    expect(entries.filter((entry) => matchesQuery(entry, "acme.old")).map((entry) => entry.id)).toEqual(["acme.old"]);
  });

  it("says in one line what an extension is, from its manifest or else from what it adds", () => {
    expect(extensionBlurb(byId("tau.terminal"))).toBe("A shell beside the chat.");
    expect(extensionBlurb(byId("tau.review"))).toBe("Adds review.");
  });
});
