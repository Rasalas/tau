// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExtensionRegistry, type WorkbenchActions } from "../extension-system";
import { WorkbenchShellContext } from "../workbench-context";
import { Slot } from "./Slot";

const actions = {} as WorkbenchActions;

describe("Slot", () => {
  it("draws what another kit registered at a kit's own place, named as a part", () => {
    const registry = new ExtensionRegistry();
    registry.activate({ id: "acme.meter", name: "Meter", activate(context) {
      context.registerRegion({ id: "acme.meter.usage", placement: "tau.usage/page-end", Component: () => <p>metered</p> });
    } });
    const { container } = render(<WorkbenchShellContext.Provider value={{ registry }}><Slot name="tau.usage/page-end" actions={actions} /></WorkbenchShellContext.Provider>);
    const region = container.querySelector('[data-placement="tau.usage/page-end"]');
    expect(region?.className).toBe("workbench-region region-tau-usage-page-end");
    expect(region?.querySelector('[data-tau-part="region:acme.meter.usage"]')?.textContent).toBe("metered");
  });

  it("draws nothing outside a workbench", () => {
    expect(render(<Slot name="tau.usage/page-end" actions={actions} />).container.innerHTML).toBe("");
  });
});
