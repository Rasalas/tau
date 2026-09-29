// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { appleDynamicType, applyTypeScale, clampTextScale, deviceClassFor, type SystemTextScale } from "./type-scale";

function fakeSystem(initial: number | undefined): SystemTextScale & { set(value: number): void } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => value,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    set: (next) => { value = next; for (const listener of listeners) listener(); },
  };
}

afterEach(() => {
  delete document.documentElement.dataset.device;
  document.documentElement.removeAttribute("style");
  vi.unstubAllGlobals();
});

describe("deviceClassFor", () => {
  it("reads a touch client by its screen, and anything else as a desktop", () => {
    expect(deviceClassFor("compact", true, 393)).toBe("phone");
    expect(deviceClassFor("compact", true, 820)).toBe("tablet");
    // An iPad's split window is still an iPad; a narrowed desktop window is still a desktop.
    expect(deviceClassFor("compact", true, 744)).toBe("tablet");
    expect(deviceClassFor("compact", false, 393)).toBe("desktop");
    expect(deviceClassFor("web", true, 393)).toBe("desktop");
    expect(deviceClassFor("desktop", false, 900)).toBe("desktop");
  });
});

describe("clampTextScale", () => {
  it("keeps the default below it and stops at the largest the layout holds", () => {
    expect(clampTextScale(undefined)).toBe(1);
    expect(clampTextScale(Number.NaN)).toBe(1);
    expect(clampTextScale(14 / 17)).toBe(1);
    expect(clampTextScale(23 / 17)).toBe(1.35);
    expect(clampTextScale(1.3)).toBe(1.3);
    expect(clampTextScale(53 / 17)).toBe(1.5);
  });
});

describe("applyTypeScale", () => {
  const root = () => document.documentElement;

  it("marks a phone and follows the system's text size", () => {
    const system = fakeSystem(1);
    const stop = applyTypeScale("phone", system);
    expect(root().dataset.device).toBe("phone");
    expect(root().style.getPropertyValue("--text-scale")).toBe("");
    system.set(21 / 17);
    expect(root().style.getPropertyValue("--text-scale")).toBe("1.24");
    system.set(1);
    expect(root().style.getPropertyValue("--text-scale")).toBe("");
    stop();
    expect(root().dataset.device).toBeUndefined();
  });

  it("leaves a desktop at the design's scale", () => {
    root().dataset.device = "phone";
    applyTypeScale("desktop", fakeSystem(1.3));
    expect(root().dataset.device).toBeUndefined();
    expect(root().style.getPropertyValue("--text-scale")).toBe("");
  });

  it("marks a tablet without a system source", () => {
    applyTypeScale("tablet");
    expect(root().dataset.device).toBe("tablet");
    expect(root().style.getPropertyValue("--text-scale")).toBe("");
  });
});

describe("appleDynamicType", () => {
  it("is absent where the engine has no -apple-system-body", () => {
    vi.stubGlobal("CSS", { supports: () => false });
    expect(appleDynamicType(document)).toBeUndefined();
  });

  it("reads Body over its default 17px", () => {
    vi.stubGlobal("CSS", { supports: (property: string, value: string) => property === "font" && value === "-apple-system-body" });
    const system = appleDynamicType(document)!;
    const probe = document.querySelector<HTMLElement>(".system-text-probe")!;
    expect(probe.getAttribute("aria-hidden")).toBe("true");
    // jsdom does not know the system font: stand in for WebKit's Accessibility Large (23px).
    probe.style.fontSize = "23px";
    expect(system.read()).toBeCloseTo(23 / 17);
    probe.remove();
  });
});
