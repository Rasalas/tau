// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { partName, type Customizations, type CustomizationLayer, type ReplacementProps } from "./customization";
import { Region } from "./components/Regions";
import { ExtensionRegistry, type PageSummaryProps, type RegionProps, type WorkbenchActions } from "./extension-system";

function layer(initial: Customizations): CustomizationLayer & { set(next: Customizations): void } {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set(next) { snapshot = next; for (const listener of listeners) listener(); },
  };
}

function usageKit(registry: ExtensionRegistry) {
  registry.activate({ id: "tau.usage", name: "Usage", activate(context) {
    context.registerRegion({ id: "usage.juicebars", placement: "thread-list-title", order: 10, Component: () => <b>bars</b> });
    context.registerRegion({ id: "usage.other", placement: "thread-list-title", order: 20, Component: () => <i>other</i> });
    context.registerPage({ id: "usage", label: "Usage", Summary: () => <b>bars</b>, Component: () => null });
  } });
}

const actions = {} as WorkbenchActions;

describe("customizations by part name", () => {
  it("names a part by kind, id and field", () => {
    expect(partName("region", "usage.juicebars")).toBe("region:usage.juicebars");
    expect(partName("page", "usage", "Summary")).toBe("page:usage/Summary");
  });

  it("hides, orders, moves and replaces parts, and follows the layer live", () => {
    const registry = new ExtensionRegistry();
    usageKit(registry);
    const user = layer({ hidden: ["region:usage.juicebars"] });
    registry.activate({ id: "tau.customize", name: "Customize", activate(context) { context.registerCustomizations(user); } });

    expect(registry.getRegions("thread-list-title").map((region) => region.id)).toEqual(["usage.other"]);

    user.set({ order: { "region:usage.juicebars": 30 } });
    expect(registry.getRegions("thread-list-title").map((region) => region.id)).toEqual(["usage.other", "usage.juicebars"]);

    user.set({ placement: { "region:usage.juicebars": "title-bar" } });
    expect(registry.getRegions("thread-list-title").map((region) => region.id)).toEqual(["usage.other"]);
    expect(registry.getRegions("title-bar").map((region) => region.id)).toEqual(["usage.juicebars"]);

    const Mine = ({ Original }: ReplacementProps<RegionProps>) => <span>mine <Original actions={actions} /></span>;
    user.set({ replaced: { "region:usage.juicebars": Mine } });
    const { container } = render(<Region registry={registry} placement="thread-list-title" actions={actions} />);
    const part = container.querySelector('[data-tau-part="region:usage.juicebars"]');
    expect(part?.textContent).toBe("mine bars");
  });

  it("keeps a replaced component's identity across snapshots, so its state survives", () => {
    const registry = new ExtensionRegistry();
    usageKit(registry);
    const Mine = () => <span>mine</span>;
    const user = layer({ replaced: { "region:usage.juicebars": Mine } });
    registry.activate({ id: "tau.customize", name: "Customize", activate(context) { context.registerCustomizations(user); } });
    const first = registry.getRegions("thread-list-title")[0]!.Component;
    user.set({ replaced: { "region:usage.juicebars": Mine }, order: { "region:usage.other": 1 } });
    expect(registry.getRegions("thread-list-title").find((region) => region.id === "usage.juicebars")!.Component).toBe(first);
  });

  it("hides or replaces a page's Summary and leaves the page", () => {
    const registry = new ExtensionRegistry();
    usageKit(registry);
    const user = layer({ hidden: ["page:usage/Summary"] });
    registry.activate({ id: "tau.customize", name: "Customize", activate(context) { context.registerCustomizations(user); } });
    expect(registry.getPage("usage")?.Summary).toBeUndefined();
    expect(registry.getPage("usage")?.Component).toBeDefined();

    const Bar = (_props: ReplacementProps<PageSummaryProps>) => <em>my bar</em>;
    user.set({ replaced: { "page:usage/Summary": Bar } });
    const Summary = registry.getPage("usage")!.Summary!;
    expect(render(<Summary actions={actions} />).container.textContent).toBe("my bar");
  });

  it("lists every part with what the layer does to it, and lets the last layer apply", () => {
    const registry = new ExtensionRegistry();
    usageKit(registry);
    const first = layer({ hidden: ["region:usage.other"] });
    const second = layer({ hidden: ["region:usage.juicebars"] });
    let dispose: (() => void) | undefined;
    registry.activate({ id: "a", name: "A", activate(context) { context.registerCustomizations(first); } });
    registry.activate({ id: "b", name: "B", activate(context) { dispose = context.registerCustomizations(second); } });

    const parts = registry.getCustomizableParts();
    expect(parts.map((part) => part.name)).toEqual(["region:usage.juicebars", "region:usage.other", "page:usage", "page:usage/Summary"]);
    expect(parts.find((part) => part.name === "region:usage.juicebars")).toMatchObject({ hidden: true, extensionId: "tau.usage", placement: "thread-list-title" });

    dispose?.();
    expect(registry.getRegions("thread-list-title").map((region) => region.id)).toEqual(["usage.juicebars"]);
    registry.deactivate("a");
    expect(registry.getRegions("thread-list-title").map((region) => region.id)).toEqual(["usage.juicebars", "usage.other"]);
  });
});
