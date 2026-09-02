// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionRegistry, type WorkbenchActions } from "../extension-system";
import { Region, StatusLine } from "./Regions";

afterEach(cleanup);
const actions = {} as WorkbenchActions;

describe("Region and StatusLine", () => {
  it("render nothing without contributions and everything registered for their placement", async () => {
    const registry = new ExtensionRegistry({ invoke: async () => undefined });
    const view = render(<><Region registry={registry} placement="composer-above" actions={actions} /><StatusLine registry={registry} actions={actions} /></>);
    expect(view.container.innerHTML).toBe("");

    registry.activate({ id: "kit", name: "Kit", activate(context) {
      context.registerRegion({ id: "widget", placement: "composer-above", Component: () => <em>widget</em> });
      context.registerRegion({ id: "footer", placement: "transcript-footer", Component: () => <em>footer</em> });
      context.registerStatusItem({ id: "cwd", Component: () => <span>~/project</span> });
      context.registerStatusItem({ id: "tokens", align: "right", Component: () => <span>1.2k tokens</span> });
    } });
    expect(await screen.findByText("widget")).toBeTruthy();
    expect(screen.queryByText("footer")).toBeNull();
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("~/project");
    expect(status.textContent).toContain("1.2k tokens");
  });
});
