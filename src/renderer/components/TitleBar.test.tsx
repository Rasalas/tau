// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(document.querySelector(".title-bar > .window-controls-inset")).not.toBeNull();
    expect(view.getByText("Kit action")).toBeTruthy();
    expect(view.getByText("project")).toBeTruthy();
  });
});
