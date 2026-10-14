// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { customizeExtension } from "./desktop.js";
import { CUSTOMIZE_CHANGED_EVENT, CUSTOMIZE_EXTENSION_ID, EMPTY_STATE, type CustomizeState } from "./protocol.js";
import { readState } from "./store.js";

afterEach(cleanup);

const actions = new Proxy({}, { get: () => () => undefined }) as WorkbenchActions;
const settled = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

function world(initial: Partial<CustomizeState>) {
  let state = readState(initial);
  const calls: Array<[string, unknown]> = [];
  const { registry } = createKitHarness(async (extensionId, command, input) => {
      if (extensionId !== CUSTOMIZE_EXTENSION_ID) return undefined;
      calls.push([command, input]);
      if (command === "get") return state;
      if (command === "set") { state = readState((input as { state: unknown }).state, state); return state; }
      if (command === "open-script") return { state: "ready", path: "/resources/frame-1", maxHeight: 480 };
      return {};
  }, undefined, undefined, { resourceUrl: (path) => `tau-ext://resources${path}` });
  registry.activate({ id: "tau.usage", name: "Usage", activate(context) {
    context.registerRegion({ id: "usage.juicebars", placement: "thread-list-title", Component: () => <b>bars</b> });
    context.registerPage({ id: "usage", label: "Usage", Summary: () => <b>bars</b>, Component: () => null });
  } });
  registry.activate(customizeExtension);
  const push = (next: Partial<CustomizeState>) => {
    state = readState(next, state);
    act(() => registry.dispatchExtensionEvent({ type: "extension-event", extensionId: CUSTOMIZE_EXTENSION_ID, name: CUSTOMIZE_CHANGED_EVENT, payload: state }));
  };
  return { registry, calls, push };
}

describe("Customize Kit desktop extension", () => {
  it("hides what the machine stored and follows the host's changes", async () => {
    const { registry, push } = world({ hidden: ["region:usage.juicebars"] });
    await settled();
    expect(registry.getRegions("thread-list-title").map((region) => region.id)).not.toContain("usage.juicebars");
    push({ ...EMPTY_STATE });
    expect(registry.getRegions("thread-list-title").map((region) => region.id)).toContain("usage.juicebars");
  });

  it("draws a replacing script in the part's place, inline in the sidebar's foot", async () => {
    const { registry, calls } = world({ scripts: [{ id: "bar", name: "My bar", enabled: true, target: { replace: "page:usage/Summary" }, html: "<b>mine</b>", revision: 1 }] });
    await settled();
    const Summary = registry.getPage("usage")!.Summary!;
    render(<Summary actions={actions} />);
    await waitFor(() => expect(document.querySelector("iframe")?.getAttribute("src")).toBe("tau-ext://resources/resources/frame-1"));
    expect(calls).toContainEqual(["open-script", expect.objectContaining({ id: "bar", inline: true })]);
    expect(document.querySelector(".customize-script")?.hasAttribute("data-inline")).toBe(true);
  });

  it("adds a script of its own at a placement, and takes it away when it is switched off", async () => {
    const { registry, push } = world({ scripts: [{ id: "note", name: "Note", enabled: true, target: { placement: "thread-list-title", order: -5 }, html: "<i>note</i>", revision: 1 }] });
    await settled();
    expect(registry.getRegions("thread-list-title").map((region) => region.id)).toEqual(["customize.script.note", "usage.juicebars"]);
    push({ scripts: [{ id: "note", name: "Note", enabled: false, target: { placement: "thread-list-title", order: -5 }, html: "<i>note</i>", revision: 1 }] });
    expect(registry.getRegions("thread-list-title").map((region) => region.id)).toEqual(["usage.juicebars"]);
  });

  it("mounts the user's styles after every sheet, in their order, and removes them with the kit", async () => {
    const { registry, push } = world({ styles: [
      { id: "a", name: "A", css: ".a{}", enabled: true },
      { id: "b", name: "B", css: ".b{}", enabled: true },
    ] });
    await settled();
    const styles = () => [...document.head.querySelectorAll("style[data-tau-user-style]")].map((element) => element.textContent);
    expect(styles()).toEqual([".a{}", ".b{}"]);
    push({ styles: [{ id: "b", name: "B", css: ".b{color:red}", enabled: true }, { id: "a", name: "A", css: ".a{}", enabled: false }] });
    expect(styles()).toEqual([".b{color:red}"]);
    registry.deactivate(CUSTOMIZE_EXTENSION_ID);
    expect(styles()).toEqual([]);
  });

  it("writes a change from Settings to the host and keeps it when the host agrees", async () => {
    const { registry, calls } = world({});
    await settled();
    const page = registry.getSettingsPages().find((entry) => entry.id === "customize")!;
    render(<page.Component onNotify={() => undefined} />);
    const toggle = await screen.findByRole("switch", { name: "Show usage.juicebars" });
    act(() => toggle.click());
    await settled();
    expect(calls.find(([command]) => command === "set")?.[1]).toMatchObject({ state: { hidden: ["region:usage.juicebars"] } });
    expect(registry.getRegions("thread-list-title").map((region) => region.id)).not.toContain("usage.juicebars");
  });
});
