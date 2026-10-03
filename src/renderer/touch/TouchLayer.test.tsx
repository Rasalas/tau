// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadStore } from "../../workbench/thread-store";
import { PHONE_HOME } from "../../workbench/phone-route";
import { ClientEnvironmentProvider, electronClientEnvironment } from "../client-environment";
import { ThreadStoreContext } from "../workbench-context";
import { TouchLayer } from "./TouchLayer";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function fixture(platform: "ios" | "android" | undefined, phone = false) {
  const visual = Object.assign(new EventTarget(), { height: 1180, offsetTop: 0 });
  vi.stubGlobal("visualViewport", visual);
  vi.stubGlobal("innerHeight", 1180);
  const environment = {
    ...electronClientEnvironment(new URLSearchParams()),
    ...(platform ? { mobileApp: { platform, version: "test" } } : {}),
  };
  const view = render(<ClientEnvironmentProvider environment={environment}>
    <ThreadStoreContext.Provider value={new ThreadStore()}>
      <TouchLayer syncUrl={false} openThread={async () => false}
        {...(phone ? { phone: { route: PHONE_HOME, onRoute: () => {} } } : {})} />
    </ThreadStoreContext.Provider>
  </ClientEnvironmentProvider>);
  const resize = (height: number, offsetTop = 0) => {
    act(() => {
      Object.assign(visual, { height, offsetTop });
      visual.dispatchEvent(new Event("resize"));
    });
  };
  const style = (name: string) => document.documentElement.style.getPropertyValue(name);
  return { ...view, resize, style };
}

describe("the native tablet's floating shortcut bar", () => {
  it("reserves space below the composer while leaving the sidebar in place", () => {
    const { resize, style, unmount } = fixture("ios");
    resize(1125);
    expect(style("--tau-viewport-height")).toBe("1180px");
    expect(style("--tau-viewport-top")).toBe("0px");
    expect(style("--tau-keyboard-inset")).toBe("55px");
    expect(document.body.hasAttribute("data-floating-toolbar")).toBe(true);
    expect(document.body.hasAttribute("data-keyboard")).toBe(false);
    resize(1125, 80);
    expect(style("--tau-viewport-top")).toBe("0px");
    expect(style("--tau-keyboard-inset")).toBe("55px");
    resize(780, 80);
    expect(style("--tau-viewport-height")).toBe("780px");
    expect(style("--tau-viewport-top")).toBe("80px");
    expect(style("--tau-keyboard-inset")).toBe("320px");
    expect(document.body.hasAttribute("data-floating-toolbar")).toBe(false);
    expect(document.body.hasAttribute("data-keyboard")).toBe(true);
    resize(1180);
    expect(style("--tau-keyboard-inset")).toBe("0px");
    expect(document.body.hasAttribute("data-floating-toolbar")).toBe(false);
    unmount();
    expect(style("--tau-viewport-height")).toBe("");
    expect(document.body.hasAttribute("data-keyboard")).toBe(false);
  });

  it.each([["ios", true], ["android", false], [undefined, false]] as const)(
    "fits the whole viewport for %s, phone=%s",
    (platform, phone) => {
      const { resize, style } = fixture(platform, phone);
      resize(1125);
      expect(style("--tau-viewport-height")).toBe("1125px");
      expect(document.body.hasAttribute("data-floating-toolbar")).toBe(false);
    },
  );
});
