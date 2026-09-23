// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRegistry, type WorkbenchActions } from "../extension-system";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TitleBar } from "./TitleBar";

afterEach(cleanup);

describe("TitleBar", () => {
  it("reserves the macOS traffic-light inset before the workspace title and lends a region to extensions", () => {
    const registry = new ExtensionRegistry({ invoke: async () => undefined });
    registry.activate({ id: "kit", name: "Kit", activate(context) {
      context.registerRegion({ id: "kit.actions", placement: "title-bar", Component: () => <button>Kit action</button> });
    } });
    const client = createFakeHostClient({ platform: "darwin" });
    const view = render(<HostClientProvider client={client}>
      <TitleBar cwd="/project" dockOpen registry={registry} actions={{} as WorkbenchActions} onToggleDock={() => undefined} />
    </HostClientProvider>);
    expect(document.querySelector(".title-bar > .title-lead > .window-controls-inset")).not.toBeNull();
    expect(view.getByText("Kit action")).toBeTruthy();
    expect(view.getByText("project")).toBeTruthy();
  });

  it("is one row: project / thread as a breadcrumb, then the drawer and dock toggles", () => {
    const registry = new ExtensionRegistry({ invoke: async () => undefined });
    const newSession = vi.fn();
    const onToggle = vi.fn();
    const view = render(<TitleBar
      cwd="/work/project"
      dockOpen={false}
      registry={registry}
      actions={{ newSession } as unknown as WorkbenchActions}
      thread={<button>Fix the rail</button>}
      drawers={[{ id: "terminal", label: "Terminal", open: false, onToggle }]}
      onToggleDock={() => undefined}
    />);
    const crumbs = view.getByRole("navigation", { name: "Thread breadcrumb" });
    expect(crumbs.textContent).toBe("project/Fix the rail");
    fireEvent.click(view.getByRole("button", { name: "New thread in project" }));
    expect(newSession).toHaveBeenCalledWith({ workspace: "/work/project" });
    fireEvent.click(view.getByRole("button", { name: "Toggle Terminal drawer" }));
    expect(onToggle).toHaveBeenCalled();
    expect(view.getByRole("button", { name: "Show panel" })).toBeTruthy();
  });
});
