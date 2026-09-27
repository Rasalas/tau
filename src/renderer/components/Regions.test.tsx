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
    const status = await screen.findByLabelText("Status line");
    expect(status.textContent).toContain("~/project");
    expect(status.textContent).toContain("1.2k tokens");
  });

  it("draws core's own controls after the contributions, and alone when there are none", async () => {
    const registry = new ExtensionRegistry({ invoke: async () => undefined });
    const view = render(<Region registry={registry} placement="composer-controls" actions={actions}><button type="button">core</button></Region>);
    const row = view.container.querySelector(".region-composer-controls")!;
    expect([...row.children].map((child) => child.textContent)).toEqual(["core"]);

    registry.activate({ id: "kit", name: "Kit", activate(context) {
      context.registerRegion({ id: "pill", placement: "composer-controls", Component: () => <span>pill</span> });
    } });
    await screen.findByText("pill");
    expect(row.textContent).toBe("pillcore");
  });
});
