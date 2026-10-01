import { describe, expect, it } from "vitest";
import { ProjectFactsCache } from "./project-facts-cache.js";

function cache() {
  const labels: Array<{ cwd: string; label: string | undefined }> = [];
  const nesting: string[] = [];
  const names: Array<{ cwd: string; name: string }> = [];
  const background: string[] = [];
  const logs: string[] = [];
  const facts = new ProjectFactsCache({
    onLabel: (cwd, label) => { labels.push({ cwd, label }); },
    onName: (cwd, name) => { names.push({ cwd, name }); },
    onNesting: (cwd) => { nesting.push(cwd); },
    recordBackground: (name) => { background.push(name); },
    log: (label, detail) => { logs.push(`${label}: ${detail ?? ""}`); },
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
  });
  return { facts, labels, nesting, names, background, logs };
}

/** Every answer arrives in a background task; the caller only ever reads the cache. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("ProjectFactsCache", () => {
  it("falls back to the folder name until a provider answers", async () => {
    const { facts } = cache();
    expect(facts.name("/tmp/widgets")).toBe("widgets");
    facts.add({ name: async () => "Widgets" });
    expect(await facts.loadName("/tmp/widgets")).toBe("Widgets");
    expect(facts.name("/tmp/widgets")).toBe("Widgets");
  });

  it("keeps a remembered name instead of asking again", async () => {
    const { facts } = cache();
    let asked = 0;
    facts.add({ name: async () => { asked += 1; return "Provided"; } });
    facts.rememberName("/tmp/widgets", "Linked");
    expect(await facts.loadName("/tmp/widgets")).toBe("Linked");
    expect(asked).toBe(0);
  });

  it("reads the name of a path nobody opened in the background and publishes it once", async () => {
    const { facts, names } = cache();
    let asked = 0;
    facts.add({ name: async (cwd) => { asked += 1; return cwd.endsWith("-2") ? "Widgets" : undefined; } });
    expect(facts.name("/work/widgets-2")).toBe("widgets-2");
    expect(facts.name("/work/widgets-2")).toBe("widgets-2");
    await settle();
    expect(names).toEqual([{ cwd: "/work/widgets-2", name: "Widgets" }]);
    expect(facts.name("/work/widgets-2")).toBe("Widgets");
    // A path no provider names is asked once, not on every read, and again after a provider is added.
    facts.name("/work/plain");
    await settle();
    facts.name("/work/plain");
    await settle();
    expect(asked).toBe(2);
    expect(names).toHaveLength(1);
    facts.add({ name: async () => "Plain" });
    facts.name("/work/plain");
    await settle();
    expect(names.at(-1)).toEqual({ cwd: "/work/plain", name: "Plain" });
  });

  it("never awaits a label and publishes it once it changes", async () => {
    const { facts, labels, background } = cache();
    let value = "main";
    facts.add({ label: async () => value });
    expect(facts.label("/repo")).toBeUndefined();
    await settle();
    expect(labels).toEqual([{ cwd: "/repo", label: "main" }]);
    expect(facts.label("/repo")).toBe("main");
    await settle();
    // The unchanged answer is not published a second time.
    expect(labels).toHaveLength(1);
    value = "feature";
    facts.label("/repo");
    await settle();
    expect(labels.at(-1)).toEqual({ cwd: "/repo", label: "feature" });
    expect(background.every((name) => name === "project-label")).toBe(true);
  });

  it("logs a failing label provider and leaves the path unlabelled", async () => {
    const { facts, labels, logs } = cache();
    facts.add({ label: async () => { throw new Error("status scan failed"); } });
    facts.label("/repo");
    await settle();
    expect(labels).toEqual([]);
    expect(logs[0]).toContain("project-label.failed");
    expect(facts.knownLabel("/repo")).toBeUndefined();
  });

  it("withholds an unclassified path from the roots until its answer arrives", async () => {
    const { facts, nesting } = cache();
    facts.add({ nested: async (cwd) => cwd === "/repo/worktree" });
    expect(facts.isRoot("/repo/worktree")).toBe(false);
    await facts.settleClassifications();
    expect(nesting).toEqual(["/repo/worktree"]);
    expect(facts.isRoot("/repo/worktree")).toBe(false);
    expect(facts.isRoot("/repo")).toBe(false);
    await facts.settleClassifications();
    expect(facts.isRoot("/repo")).toBe(true);
  });

  it("treats a path no provider can classify as a root", async () => {
    const { facts } = cache();
    facts.add({ nested: async () => { throw new Error("not a checkout"); } });
    facts.classify("/elsewhere");
    await facts.settleClassifications();
    expect(facts.isRoot("/elsewhere")).toBe(true);
  });
});
