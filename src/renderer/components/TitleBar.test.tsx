// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtensionRegistry, type WorkbenchActions } from "../extension-system";
import { TitleBar } from "./TitleBar";

beforeEach(() => { window.tau = { platform: "darwin" } as typeof window.tau; });
afterEach(() => { cleanup(); delete window.tau; });

describe("TitleBar", () => {
  it("reserves the macOS traffic-light inset before the workspace title and lends a region to extensions", () => {
    const registry = new ExtensionRegistry({ invoke: async () => undefined });
    registry.activate({ id: "kit", name: "Kit", activate(context) {
      context.registerRegion({ id: "kit.actions", placement: "title-bar", Component: () => <button>Kit action</button> });
    } });
    const view = render(<TitleBar cwd="/project" dockOpen registry={registry} actions={{} as WorkbenchActions} onToggleDock={() => undefined} />);
    expect(document.querySelector(".title-bar > .window-controls-inset")).not.toBeNull();
    expect(view.getByText("Kit action")).toBeTruthy();
    expect(view.getByText("project")).toBeTruthy();
  });
});
