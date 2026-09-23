import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PreviewHistory, rememberable } from "./history.js";
import { PreviewMiniState, readMiniPrefs } from "./mini-state.js";

const directories: string[] = [];
async function directory(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), "tau-preview-history-"));
  directories.push(made);
  return made;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("recent pages", () => {
  it("keeps web pages and files, newest first, once each, with the newest title", async () => {
    let now = 0;
    const history = new PreviewHistory("", () => ++now);
    history.visit("http://localhost:3000/", "Home");
    history.visit("about:blank", "");
    history.visit("http://localhost:3000/settings", "");
    history.visit("http://localhost:3000/", "");
    expect(await history.list()).toEqual([
      { url: "http://localhost:3000/", title: "Home", visitedAt: 3 },
      { url: "http://localhost:3000/settings", visitedAt: 2 },
    ]);
    expect(await history.forget("http://localhost:3000/")).toEqual([{ url: "http://localhost:3000/settings", visitedAt: 2 }]);
    expect(rememberable("file:///project/index.html")).toBe(true);
    expect(rememberable("javascript:alert(1)")).toBe(false);
  });

  it("stays on disk, and a visit before the file was read keeps what the file held", async () => {
    const stateDir = await directory();
    const first = new PreviewHistory(stateDir, () => 1);
    first.visit("http://a.test/", "A");
    await first.flush();
    const second = new PreviewHistory(stateDir, () => 2);
    second.visit("http://b.test/", "B");
    await second.flush();
    expect((await new PreviewHistory(stateDir).list()).map((entry) => entry.url)).toEqual(["http://b.test/", "http://a.test/"]);
    expect(await readFile(join(stateDir, "history.json"), "utf8")).toContain("http://b.test/");
  });
});

describe("the floating preview's state", () => {
  it("follows the thread that drives, until its turn ends", () => {
    const state = new PreviewMiniState("", () => 5);
    expect(state.drive("t1", "browser")).toBe(true);
    expect(state.drive("t1", "browser")).toBe(false);
    expect(state.dismiss()).toBe(true);
    expect(state.driver()).toEqual({ threadId: "t1", source: "browser", since: 5, dismissed: true });
    // Another surface is another drive, shown again.
    expect(state.drive("t1", "screen")).toBe(true);
    expect(state.driver()?.dismissed).toBeUndefined();
    expect(state.release("t2")).toBe(false);
    expect(state.release("t1")).toBe(true);
    expect(state.driver()).toBeUndefined();
    expect(state.dismiss()).toBe(false);
  });

  it("remembers its corner and width, within bounds", async () => {
    const stateDir = await directory();
    const state = new PreviewMiniState(stateDir);
    expect(await state.setPrefs({ corner: "top-left", width: 9_000 })).toEqual({ corner: "top-left", width: 560 });
    expect(await new PreviewMiniState(stateDir).load()).toEqual({ corner: "top-left", width: 560 });
    expect(readMiniPrefs({ corner: "middle", width: 10 })).toEqual({ corner: "bottom-right", width: 160 });
  });
});
