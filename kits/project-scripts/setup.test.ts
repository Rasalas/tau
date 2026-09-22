import { describe, expect, it } from "vitest";
import type { ProjectScript, UiScriptRun, UiWorktreeSetup } from "./protocol.js";
import { SETUP_LIMIT, SetupTracker, outputTail } from "./setup.js";

const script = (id: string, async: boolean): ProjectScript => ({
  id, name: id === "install" ? "Install" : "Build", command: `npm run ${id}`, icon: "configure", runOnWorktreeCreate: true, async, autoOpenPreview: false,
});

const run = (id: string, patch: Partial<UiScriptRun> = {}): UiScriptRun => ({
  id, scriptId: "install", name: "Install", command: "npm ci", icon: "configure", directory: "/wt", trigger: "worktree-create",
  status: "running", startedAt: 10, output: "", outputLength: 0, autoOpenPreview: false, ...patch,
});

function tracker() {
  const pushed: UiWorktreeSetup[] = [];
  let now = 0;
  const setups = new SetupTracker({ emit: (setup) => pushed.push(setup), now: () => (now += 1) });
  const statuses = () => pushed.at(-1)?.stages.map((stage) => `${stage.id}:${stage.status}`);
  return { setups, pushed, statuses };
}

describe("worktree setup steps", () => {
  it("walks fetch, checkout and each script in order", async () => {
    const { setups, pushed, statuses } = tracker();
    const { id } = setups.begin({ project: "/repo", branch: "tau/x", scripts: [script("install", false), script("build", true)] });
    expect(statuses()).toEqual(["fetch:pending", "checkout:pending", "script:install:pending", "script:build:pending"]);
    setups.step(id, "fetch");
    expect(statuses()).toEqual(["fetch:running", "checkout:pending", "script:install:pending", "script:build:pending"]);
    setups.step(id, "checkout");
    setups.created(id, "/wt");
    expect(statuses()).toEqual(["fetch:done", "checkout:done", "script:install:pending", "script:build:pending"]);
    expect(pushed.at(-1)?.worktree).toBe("/wt");

    setups.attach(id, "install", run("r1", { output: "\u001b[32mresolving\u001b[0m\nadded 3 packages\n" }));
    expect(statuses()?.[2]).toBe("script:install:running");
    expect(pushed.at(-1)?.stages[2]?.tail).toEqual(["resolving", "added 3 packages"]);
    setups.runChanged(run("r1", { status: "failed", exitCode: 1, endedAt: 20 }));
    expect(pushed.at(-1)?.stages[2]).toMatchObject({ status: "failed", detail: "exit 1", endedAt: 20 });

    let released = false;
    void setups.released(id).then(() => { released = true; });
    setups.finish(id);
    await Promise.resolve();
    expect(released).toBe(true);
    expect(pushed.at(-1)).toMatchObject({ phase: "done" });
    expect(statuses()?.[3]).toBe("script:build:skipped");
  });

  it("skips the fetch for a branch that already exists", () => {
    const { setups, statuses } = tracker();
    const { id } = setups.begin({ project: "/repo", scripts: [] });
    setups.step(id, "checkout");
    setups.created(id, "/wt");
    expect(statuses()).toEqual(["fetch:skipped", "checkout:done"]);
  });

  it("cancels: running scripts are named for stopping, the rest never start, and the wait ends", async () => {
    const { setups, pushed } = tracker();
    const { id } = setups.begin({ project: "/repo", scripts: [script("install", false), script("build", false)] });
    setups.created(id, "/wt");
    setups.attach(id, "install", run("r1"));
    let released = false;
    void setups.released(id).then(() => { released = true; });
    expect(setups.cancel(id)).toEqual(["r1"]);
    await Promise.resolve();
    expect(released).toBe(true);
    expect(setups.isCancelled(id)).toBe(true);
    expect(pushed.at(-1)?.stages[3]).toMatchObject({ status: "skipped", detail: "cancelled" });
    setups.runChanged(run("r1", { status: "stopped", endedAt: 30 }));
    setups.finish(id);
    expect(pushed.at(-1)?.phase).toBe("cancelled");
    expect(pushed.at(-1)?.stages[2]).toMatchObject({ status: "skipped", detail: "cancelled" });
    expect(setups.cancel(id)).toEqual([]);
  });

  it("lets the thread start before a blocking script ends", async () => {
    const { setups, pushed } = tracker();
    const { id } = setups.begin({ project: "/repo", scripts: [script("install", false)] });
    let released = false;
    void setups.released(id).then(() => { released = true; });
    expect(setups.release(id)).toBe(true);
    await Promise.resolve();
    expect(released).toBe(true);
    expect(pushed.at(-1)).toMatchObject({ phase: "running", released: true });
    expect(setups.release(id)).toBe(false);
  });

  it("ends a setup whose worktree could not be made", () => {
    const { setups, pushed } = tracker();
    const { id } = setups.begin({ project: "/repo", scripts: [script("install", false)] });
    setups.step(id, "fetch");
    setups.failed(id, "origin is unreachable");
    expect(pushed.at(-1)).toMatchObject({ phase: "failed", error: "origin is unreachable" });
    expect(pushed.at(-1)?.stages.map((stage) => stage.status)).toEqual(["failed", "skipped", "skipped"]);
    expect(setups.dismiss(id)).toBe(true);
    expect(setups.list()).toEqual([]);
  });

  it("keeps a bounded number of settled setups", () => {
    const { setups } = tracker();
    for (let index = 0; index < SETUP_LIMIT + 5; index += 1) setups.finish(setups.begin({ project: "/repo", scripts: [] }).id);
    setups.begin({ project: "/repo", scripts: [] });
    expect(setups.list().length).toBeLessThanOrEqual(SETUP_LIMIT + 1);
  });

  it("keeps the last four lines of output", () => {
    expect(outputTail("1\n2\n\n3\r\n4\n5\n")).toEqual(["2", "3", "4", "5"]);
  });
});
