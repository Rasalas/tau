import { describe, expect, it } from "vitest";
import type { UiProject, UiSession } from "../../shared/contracts";
import type { UiEnvironment } from "../../shared/environments";
import { scopeMachines, scopeProjects } from "./settings-scope";
import { levelLock } from "./setting-state";

const project = (path: string, workspaceId?: string, name = path.split("/").filter(Boolean).at(-1) ?? ""): UiProject => ({ path, ...(workspaceId ? { workspaceId } : {}), name, lastOpenedAt: 1 });

describe("the projects a project override can be made for", () => {
  it("lists one project once, by workspace id or by folder, and never the filesystem root", () => {
    const list = scopeProjects([
      project("/", "ws-root"),
      project("/Users/me/tau", "ws-1"),
      project("/Users/me/tau", "ws-2"),
      project("/Users/me/tau/", "ws-3"),
      project("/Users/me/tool", "ws-4"),
      project("/Users/me/tool", "ws-4"),
      project("C:\\", "ws-drive"),
    ], []);
    expect(list.map((entry) => entry.workspaceId)).toEqual(["ws-1", "ws-4"]);
  });

  it("leaves out the projects of other machines, whose workspace ids this host does not know", () => {
    const thread = { id: "t", path: "/s", title: "t", modifiedAt: 1, projectPath: "/home/rex/git-nrw", workspaceId: "ws-rex", projectName: "git-nrw", messageCount: 1, backendKind: "machine", machine: { id: "rex", name: "rex" } } as UiSession;
    const list = scopeProjects([project("/home/rex/git-nrw", "ws-rex"), project("/Users/me/git-nrw", "ws-mine")], [thread]);
    expect(list).toEqual([{ workspaceId: "ws-mine", label: "git-nrw", path: "/Users/me/git-nrw" }]);
  });

  it("names the folder of two projects with one name, and puts the project on screen first once", () => {
    const list = scopeProjects(
      [project("/Users/me/a/web", "ws-a"), project("/Users/me/b/web", "ws-b"), project("/Users/me/tau", "ws-tau")],
      [],
      { workspaceId: "ws-tau", label: "tau", path: "/Users/me/tau" },
    );
    expect(list).toEqual([
      { workspaceId: "ws-tau", label: "tau", path: "/Users/me/tau" },
      { workspaceId: "ws-a", label: "web", path: "/Users/me/a/web", detail: "~/a" },
      { workspaceId: "ws-b", label: "web", path: "/Users/me/b/web", detail: "~/b" },
    ]);
    expect(scopeProjects([], [], { workspaceId: "ws-root", label: "/", path: "/" })).toEqual([]);
  });
});

describe("the machines whose own settings can be edited", () => {
  const machine = (patch: Partial<UiEnvironment>): UiEnvironment => ({ id: "rex", name: "rex", local: false, status: "connected", threads: [], threadCount: 0, projects: [], ...patch });

  it("skips this window's own machine and says why a change is refused on the others", () => {
    const list = scopeMachines([
      machine({ id: "mac", name: "mac", local: true }),
      machine({}),
      machine({ id: "ro", name: "lab", readOnly: true }),
      machine({ id: "off", name: "nas", status: "offline" }),
      machine({ id: "no", name: "box", status: "refused" }),
    ]);
    expect(list.map(({ id, blocked }) => [id, blocked])).toEqual([
      ["rex", undefined],
      ["ro", "lab paired this window Read only."],
      ["off", "nas is not reachable right now."],
      ["no", "box refuses this window."],
    ]);
    expect(scopeMachines(undefined)).toEqual([]);
  });
});

describe("what a level can hold", () => {
  it("locks a machine-wide setting under a project and a project-only one on the machine", () => {
    expect(levelLock("hostBackground", "host", { editing: "project" })).toBe("Applies to the whole machine.");
    expect(levelLock("hostBackground", "host", { editing: "host" })).toBeUndefined();
    expect(levelLock("options.x.rule", "both", { editing: "project" })).toBeUndefined();
    expect(levelLock("options.x.rule", "project", { editing: "host" })).toMatch(/each project/u);
  });

  it("leaves a personal preference to the person, and a machine's other settings to its access", () => {
    const rex = { editing: "host" as const, machine: { id: "rex", name: "rex" } };
    expect(levelLock("theme", "host", rex)).toBe("Personal: applies on every machine.");
    expect(levelLock("keybindings.x", "host", rex)).toMatch(/Personal/u);
    expect(levelLock("hostBackground", "host", rex)).toBeUndefined();
    expect(levelLock("hostBackground", "host", { ...rex, machine: { ...rex.machine, blocked: "Read only" } })).toBe("Read only");
  });
});
