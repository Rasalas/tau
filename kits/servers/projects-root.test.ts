import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ServerProjects, projectsRootFrom, type ServerProjectsOptions } from "./projects";

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "tau-proj-root-"))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// Nothing past the guard is reached in these tests; a call there fails loudly.
const unreachable = new Proxy({}, { get: (_target, name) => { throw new Error(`reached ${String(name)}`); } });
function projects(root: string | undefined) {
  return new ServerProjects({
    services: unreachable, store: unreachable, targets: unreachable, ssh: unreachable, sync: unreachable,
    workspace: async () => { throw new Error("reached workspace"); },
    projectsRoot: root,
  } as unknown as ServerProjectsOptions);
}

describe("the projects root of a test instance", () => {
  it("refuses every local folder outside it, before anything is written or read", async () => {
    const root = join(dir, "projects");
    const outside = join(dir, "elsewhere");
    mkdirSync(outside);
    const guarded = projects(root);
    const refused = /is outside .*projects, the only folder this Tau makes or links server projects in \(TAU_SERVERS_PROJECTS_ROOT\)/u;
    await expect(guarded.create({ server: { alias: "fake" }, remotePath: "/srv/site", parent: outside, name: "shop" })).rejects.toThrow(refused);
    await expect(guarded.create({ server: { alias: "fake" }, remotePath: "/srv/site", parent: "~", name: "shop" })).rejects.toThrow(refused);
    await expect(guarded.inspect({ path: outside })).rejects.toThrow(refused);
    await expect(guarded.linkScan({ path: outside, targetId: "t" })).rejects.toThrow(refused);
    await expect(guarded.link({ path: outside })).rejects.toThrow(refused);
    // A link inside that leads out counts where it leads.
    mkdirSync(root, { recursive: true });
    symlinkSync(outside, join(root, "out"));
    await expect(guarded.inspect({ path: join(root, "out") })).rejects.toThrow(refused);
    // Inside, the guard lets the call on: this folder merely has no sftp.json.
    mkdirSync(join(root, "site"));
    await expect(guarded.inspect({ path: join(root, "site") })).rejects.toThrow(/reached|has no/u);
    expect(guarded.projectsRoot()).toEqual({ root });
  });

  it("makes the root when a call first needs it, and is off without one", async () => {
    const root = join(dir, "fresh", "projects");
    await expect(projects(root).inspect({ path: root })).rejects.toThrow(/reached|has no/u);
    await expect(projects(undefined).inspect({ path: dir })).rejects.not.toThrow(/is outside/u);
    expect(projects(undefined).projectsRoot()).toEqual({ root: null });
  });

  it("reads the root from TAU_SERVERS_PROJECTS_ROOT", () => {
    expect(projectsRootFrom({ TAU_SERVERS_PROJECTS_ROOT: "/w/.tau-dev/projects/" })).toBe("/w/.tau-dev/projects");
    expect(projectsRootFrom({ TAU_SERVERS_PROJECTS_ROOT: " " })).toBeUndefined();
    expect(projectsRootFrom({})).toBeUndefined();
  });
});
