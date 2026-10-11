// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRegistry, type WorkbenchActions } from "../extension-system";
import { ThreadStoreContext, WorkbenchShellContext } from "../workbench-context";
import { ThreadStore } from "../../workbench/thread-store";
import { Markdown } from "./Markdown";

afterEach(cleanup);

const session = (id: string, title: string) => ({ id, path: `/sessions/${id}.jsonl`, title, modifiedAt: 1, projectPath: "/repo", projectName: "tau", messageCount: 1 });

function draw(text: string, store = new ThreadStore()) {
  const actions = { switchSession: vi.fn(async () => true), openThread: vi.fn() } as unknown as WorkbenchActions;
  const registry = new ExtensionRegistry();
  const view = render(
    <ThreadStoreContext.Provider value={store}>
      <WorkbenchShellContext.Provider value={{ registry, actions }}><Markdown>{text}</Markdown></WorkbenchShellContext.Provider>
    </ThreadStoreContext.Provider>,
  );
  return { actions, store, ...view };
}

describe("thread links in a message", () => {
  it("shows the thread's current title, follows a rename, and opens the thread on a click", () => {
    const store = new ThreadStore();
    store.applyThreadIndex({ projects: [], sessions: [session("t1", "Fix the rail")] });
    const { actions } = draw("See [the old title](tau://thread?thread=t1) for it.", store);
    const chip = screen.getByRole("button", { name: /Fix the rail/u });
    expect(chip.textContent).toBe("TFix the rail");
    expect(screen.queryByText("the old title")).toBeNull();
    act(() => store.applyThreadIndex({ projects: [], sessions: [session("t1", "Fix the thread rail")] }));
    fireEvent.click(screen.getByRole("button", { name: /Fix the thread rail/u }));
    expect(actions.switchSession).toHaveBeenCalledWith("/sessions/t1.jsonl");
    fireEvent.click(screen.getByRole("button", { name: /Fix the thread rail/u }), { metaKey: true });
    expect(actions.openThread).toHaveBeenCalledWith("t1");
  });

  it("keeps the written label for a thread this window does not know, without a link to follow", () => {
    const { container } = draw("[Lost thread](tau://thread?thread=missing)");
    expect(container.querySelector("a, button")).toBeNull();
    expect(container.querySelector(".md-thread-link--gone")?.textContent).toBe("Lost thread");
  });

  it("does not turn other app links into anything clickable", () => {
    const { container } = draw("[usage](tau://usage?host=h) and [x](tau://thread)");
    expect(container.querySelector("a")?.getAttribute("href") ?? "").not.toMatch(/^tau:/u);
    expect(container.querySelector("button")).toBeNull();
  });
});
