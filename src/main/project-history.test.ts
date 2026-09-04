import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectHistory } from "./project-history.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ProjectHistory", () => {
  it("resolves icons for the client without storing image data in project history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-project-history-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "state", "projects.json");
    const history = new ProjectHistory(file, async () => "data:image/svg+xml;base64,aWNvbg==");

    await history.remember(join(directory, "project"), "project");
    await history.flush();

    expect(history.list()[0]?.icon).toBe("data:image/svg+xml;base64,aWNvbg==");
    expect(JSON.parse(await readFile(file, "utf8")).projects[0]).not.toHaveProperty("icon");
  });

  it("persists hidden projects without deleting them and unhides them when reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-project-history-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "projects.json");
    const history = new ProjectHistory(file);

    await history.remember("/repos/tau");
    await history.remove("/repos/tau");
    await history.flush();
    expect(history.list()).toEqual([]);
    expect(history.isHidden("/repos/tau")).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8")).hiddenPaths).toEqual(["/repos/tau"]);

    const reloaded = new ProjectHistory(file);
    await reloaded.load();
    expect(reloaded.isHidden("/repos/tau")).toBe(true);
    await reloaded.remember("/repos/tau");
    expect(reloaded.isHidden("/repos/tau")).toBe(false);
    expect(reloaded.list()[0]?.path).toBe("/repos/tau");
    await reloaded.flush();
  });

  it("writes atomically: no temp file survives and the target is complete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-project-history-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "projects.json");
    const history = new ProjectHistory(file);

    await history.remember("/repos/tau", "tau");
    await history.flush();

    const entries = await readdir(directory);
    expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(entries).toContain("projects.json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    expect(stored.version).toBe(1);
    expect(stored.projects[0].path).toBe("/repos/tau");
  });

  it("loads a legacy bare-array file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-project-history-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "projects.json");
    await writeFile(file, JSON.stringify([{ path: "/repos/tau", name: "tau", lastOpenedAt: 1 }]), "utf8");

    const history = new ProjectHistory(file);
    await history.load();

    expect(history.list()).toEqual([{ path: "/repos/tau", name: "tau", lastOpenedAt: 1 }]);
  });

  it("loads a legacy unversioned object file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-project-history-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "projects.json");
    await writeFile(file, JSON.stringify({
      projects: [{ path: "/repos/tau", name: "tau", lastOpenedAt: 1 }],
      hiddenPaths: ["/repos/hidden"],
    }), "utf8");

    const history = new ProjectHistory(file);
    await history.load();

    expect(history.list()).toEqual([{ path: "/repos/tau", name: "tau", lastOpenedAt: 1 }]);
    expect(history.isHidden("/repos/hidden")).toBe(true);
  });

  it("reads a newer-versioned file read-only-safe and never downgrades it without a real change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-project-history-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "projects.json");
    const original = JSON.stringify({
      version: 99,
      projects: [{ path: "/repos/tau", name: "tau", lastOpenedAt: 1 }],
      hiddenPaths: [],
      futureField: "kept by a newer client, not this one",
    });
    await writeFile(file, original, "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const history = new ProjectHistory(file);
    await history.load();

    expect(history.list()).toEqual([{ path: "/repos/tau", name: "tau", lastOpenedAt: 1 }]);
    expect(warn).toHaveBeenCalled();
    await history.flush();
    expect(await readFile(file, "utf8")).toBe(original);

    warn.mockRestore();
  });

  it("quarantines an unparsable file instead of silently starting over on top of it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-project-history-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "projects.json");
    await writeFile(file, "{not valid json", "utf8");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const history = new ProjectHistory(file);
    await history.load();

    expect(history.list()).toEqual([]);
    const entries = await readdir(directory);
    expect(entries).not.toContain("projects.json");
    const corrupt = entries.find((name) => name.startsWith("projects.json.corrupt-"));
    expect(corrupt).toBeDefined();
    expect(await readFile(join(directory, corrupt!), "utf8")).toBe("{not valid json");
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});
