import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectHistory } from "./project-history.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ProjectHistory", () => {
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
});
