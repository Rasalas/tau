// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionRegistry, type DesktopExtensionContext } from "../extension-system";
import { PreferencesStore } from "../preferences";
import { ThreadStoreContext, WorkbenchShellContext } from "../workbench-context";
import { ThreadStore } from "../../workbench/thread-store";
import { DraftRow } from "./DraftRow";
import { ProjectIcon } from "./ProjectIcon";
import { ThreadRow } from "./ThreadRow";

const rocket = "data:image/svg+xml,rocket";
const star = "data:image/svg+xml,star";
const favicon = "data:image/png;base64,AAAA";

function setup() {
  const preferences = new PreferencesStore();
  const registry = new ExtensionRegistry(undefined, { preferences });
  const contexts: DesktopExtensionContext[] = [];
  for (const id of ["first", "second"]) registry.activate({ id, name: id, activate(context) { contexts.push(context); } });
  const draw = (node: React.ReactNode) => render(<WorkbenchShellContext.Provider value={{ registry }}>{node}</WorkbenchShellContext.Provider>);
  return { registry, preferences, first: contexts[0]!, second: contexts[1]!, draw };
}

afterEach(cleanup);

describe("project icons a kit publishes (setProjectIcons)", () => {
  it("draws saved pictures without Workspace Kit, after published overrides and before the host's picture", () => {
    const { preferences, first, draw } = setup();
    preferences.setValue("tau.workspace", "project-icon:/backend", JSON.stringify({ kind: "image", image: rocket }));
    const { container } = draw(<ProjectIcon project={{ path: "/backend", name: "backend", workspaceId: "backend", icon: favicon }} />);
    const image = () => container.querySelector("img")?.getAttribute("src");
    expect(image()).toBe(rocket);
    act(() => first.setProjectIcons({ backend: star }));
    expect(image()).toBe(star);
    act(() => first.setProjectIcons(undefined));
    expect(image()).toBe(rocket);
    fireEvent.error(container.querySelector("img")!);
    expect(image()).toBe(favicon);
    act(() => preferences.setValue("tau.workspace", "project-icon:backend", JSON.stringify({ kind: "image", image: star })));
    expect(image()).toBe(star);
    act(() => preferences.setValue("tau.workspace", "project-icon:backend", ""));
    expect(image()).toBe(favicon);
  });

  it("shows the project initial when its picture cannot be loaded", () => {
    const { draw } = setup();
    const { container } = draw(<ProjectIcon project={{ path: "/srv/dev/repos/thk/web/backend", name: "backend", icon: favicon }} />);
    fireEvent.error(container.querySelector("img")!);
    const mark = container.querySelector(".thread-project-icon")!;
    expect(mark.querySelector("img")).toBeNull();
    expect(mark.textContent).toBe("B");
    expect(mark.className).not.toContain("has-image");
  });

  it("tries the host's picture after a published picture fails, then the initial if both fail", () => {
    const { first, draw } = setup();
    first.setProjectIcons({ backend: rocket });
    const { container } = draw(<ProjectIcon project={{ path: "/backend", name: "backend", workspaceId: "backend", icon: favicon }} icon={rocket} />);
    const image = () => container.querySelector("img")!;
    expect(image().getAttribute("src")).toBe(rocket);
    fireEvent.error(image());
    expect(image().getAttribute("src")).toBe(favicon);
    fireEvent.error(image());
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".thread-project-icon")?.textContent).toBe("B");
  });

  it("falls through a caller's picture and a worktree's picture to its owning project's", () => {
    const { draw } = setup();
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [{ path: "/repos/tau", name: "tau", workspaceId: "root", lastOpenedAt: 1, icon: star }], sessions: [] });
    const { container } = draw(<ThreadStoreContext.Provider value={store}>
      <ProjectIcon project={{ path: "/worktrees/feature", name: "tau", workspaceId: "worktree", icon: favicon }} icon={rocket} />
    </ThreadStoreContext.Provider>);
    const image = () => container.querySelector("img")!;
    fireEvent.error(image());
    expect(image().getAttribute("src")).toBe(favicon);
    fireEvent.error(image());
    expect(image().getAttribute("src")).toBe(star);
    const mark = container.querySelector<HTMLElement>(".thread-project-icon")!;
    const hue = mark.style.getPropertyValue("--project-hue");
    fireEvent.error(image());
    expect(mark.textContent).toBe("T");
    expect(mark.style.getPropertyValue("--project-hue")).toBe(hue);
  });

  it("retries pictures when the source or the project changes", () => {
    const { container, rerender } = render(<ProjectIcon project={{ path: "/backend", name: "backend", icon: favicon }} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    rerender(<ProjectIcon project={{ path: "/backend", name: "backend", icon: star }} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(star);
    rerender(<ProjectIcon project={{ path: "/backend", name: "backend", icon: favicon }} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(favicon);
    fireEvent.error(container.querySelector("img")!);
    rerender(<ProjectIcon project={{ path: "/other", name: "other", icon: favicon }} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(favicon);
  });

  it("does not hide another project's copy of a picture that failed", () => {
    const { container } = render(<>
      <ProjectIcon project={{ path: "/backend", name: "backend", icon: favicon }} />
      <ProjectIcon project={{ path: "/other", name: "other", icon: favicon }} />
    </>);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelectorAll(".thread-project-icon")[0]?.textContent).toBe("B");
  });

  it("keeps the project picture when a draft becomes a worktree thread, without caller lookups", () => {
    const { first, draw } = setup();
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [{ path: "/repos/tau", name: "tau", workspaceId: "root", lastOpenedAt: 1, icon: favicon }], sessions: [] });
    const session = { id: "t", path: "/t.jsonl", title: "Thread", modifiedAt: 1, projectPath: "/worktrees/feature", projectName: "tau", workspaceId: "worktree", messageCount: 1 };
    const { container } = draw(<ThreadStoreContext.Provider value={store}>
      <DraftRow draft={{ draftId: "d", projectName: "tau", projectPath: "/repos/tau", workspaceId: "root", preview: "", attachments: 0, createdAt: 1, active: false }} onOpen={() => {}} />
      <ThreadRow activity="idle" active={false} age="now" session={session} onSelect={() => {}} />
      <ThreadRow activity="settled" compact active={false} age="now" session={session} onSelect={() => {}} />
      <ProjectIcon project={{ path: session.projectPath, name: session.projectName, workspaceId: session.workspaceId }} />
    </ThreadStoreContext.Provider>);
    const images = () => [...container.querySelectorAll(".thread-project-icon img")].map((img) => img.getAttribute("src"));
    expect(images()).toEqual([favicon, favicon, favicon, favicon]);
    act(() => first.setProjectIcons({ root: rocket }));
    expect(images()).toEqual([rocket, rocket, rocket, rocket]);
    act(() => store.applyThreadIndex({ projects: [{ path: "/repos/tau", name: "tau", workspaceId: "root", lastOpenedAt: 1, icon: star }], sessions: [] }));
    act(() => first.setProjectIcons(undefined));
    expect(images()).toEqual([star, star, star, star]);
    act(() => first.setProjectIcons({ root: rocket, worktree: favicon }));
    expect(images()).toEqual([rocket, favicon, favicon, favicon]);
  });
  it("draws a worktree's thread with its project's initial and hue when the project has no picture", () => {
    const { draw } = setup();
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [{ path: "/repos/tau", name: "tau", workspaceId: "root", lastOpenedAt: 1 }], sessions: [] });
    const thread = (id: string, path: string) => ({ id, path: `/${id}.jsonl`, title: id, modifiedAt: 1, projectPath: path, projectName: "tau", workspaceId: `ws-${id}`, messageCount: 1 });
    const { container } = draw(<ThreadStoreContext.Provider value={store}>
      <ProjectIcon project={{ path: "/repos/tau", name: "tau", workspaceId: "root" }} />
      <ThreadRow activity="idle" active={false} age="now" session={thread("a", "/worktrees/fix-a")} onSelect={() => {}} />
      <ThreadRow activity="idle" active={false} age="now" session={thread("b", "/worktrees/feat-b")} onSelect={() => {}} />
    </ThreadStoreContext.Provider>);
    const marks = [...container.querySelectorAll<HTMLElement>(".thread-project-icon")];
    expect(marks.map((mark) => mark.textContent)).toEqual(["T", "T", "T"]);
    expect(new Set(marks.map((mark) => mark.style.getPropertyValue("--project-hue"))).size).toBe(1);
  });

  it("answers by workspace id, then path; keeps pictures only; the first extension wins; withdraws on deactivation", () => {
    const { registry, first, second } = setup();
    first.setProjectIcons({ ws1_shop: rocket, "/other": "https://example.test/x.png" });
    second.setProjectIcons({ ws1_shop: star, "/tau": star });
    expect(registry.projectIcon({ workspaceId: "ws1_shop", path: "/shop" })).toBe(rocket);
    expect(registry.projectIcon({ path: "/tau" })).toBe(star);
    expect(registry.projectIcon({ path: "/other" })).toBeUndefined();
    registry.deactivate("first");
    expect(registry.projectIcon({ workspaceId: "ws1_shop", path: "/shop" })).toBe(star);
    second.setProjectIcons(undefined);
    expect(registry.projectIcon({ path: "/tau" })).toBeUndefined();
  });

  it("draws a kit's picture before the host's, the host's before the initial, and follows a change", () => {
    const { first, draw } = setup();
    const { container, rerender } = draw(<ProjectIcon project={{ path: "/shop", name: "shop-api", workspaceId: "ws1_shop", icon: favicon }} />);
    const image = () => container.querySelector("img")?.getAttribute("src");
    expect(image()).toBe(favicon);
    act(() => first.setProjectIcons({ ws1_shop: rocket }));
    expect(image()).toBe(rocket);
    act(() => first.setProjectIcons(undefined));
    rerender(<ProjectIcon project={{ path: "/shop", name: "shop-api" }} />);
    expect(container.querySelector(".thread-project-icon")?.textContent).toBe("S");
    expect(container.querySelector(".thread-project-icon")?.className).not.toContain("has-image");
  });

  it("marks a thread row and a draft row with the kit's picture over the navigator's", () => {
    const { first, draw } = setup();
    first.setProjectIcons({ "/repos/tau": rocket });
    const session = { id: "t", path: "/t.jsonl", title: "Thread", modifiedAt: 1, projectPath: "/repos/tau", projectName: "tau", messageCount: 1 };
    const { container } = draw(<>
      <ThreadRow activity="idle" active={false} age="now" projectIcon={favicon} session={session} onSelect={() => {}} />
      <DraftRow draft={{ draftId: "d", projectName: "tau", projectPath: "/repos/tau", preview: "", attachments: 0, createdAt: 1, active: false }} onOpen={() => {}} />
    </>);
    expect([...container.querySelectorAll(".thread-project-icon img")].map((img) => img.getAttribute("src"))).toEqual([rocket, rocket]);
  });
});
