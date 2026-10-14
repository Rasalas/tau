import { afterEach, expect, it, vi } from "vitest";
import { receiveDesktopLink, takeDesktopLinks } from "./desktop-links.js";
import { installSingleInstance } from "./single-instance.js";

afterEach(() => { takeDesktopLinks(); });
it("queues cold-start and running-app links until the workbench takes them", () => {
  const listeners = new Map<string, Function>();
  const app = { requestSingleInstanceLock: () => true, quit: vi.fn(), on: (event: string, listener: Function) => listeners.set(event, listener) };
  const open = vi.fn();
  installSingleInstance(app, () => undefined, open);
  const preventDefault = vi.fn();
  listeners.get("open-url")!({ preventDefault }, "tau://new?prompt=Hello");
  listeners.get("second-instance")!({}, ["tau", "tau://new?prompt=Again&send=true"]);
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledTimes(2);
  expect(takeDesktopLinks()).toEqual(["tau://new?prompt=Hello", "tau://new?prompt=Again"]);
  expect(takeDesktopLinks()).toEqual([]);
  expect(receiveDesktopLink("https://new?prompt=No")).toBe(false);
});

it("retains an OS link that arrives before Electron is ready", () => {
  const listeners = new Map<string, Function>();
  const app = { requestSingleInstanceLock: () => true, isReady: () => false, quit: vi.fn(), on: (event: string, listener: Function) => listeners.set(event, listener) };
  const open = vi.fn();
  installSingleInstance(app, () => undefined, open);
  listeners.get("open-url")!({ preventDefault: vi.fn() }, "tau://new?prompt=Startup");
  expect(open).not.toHaveBeenCalled();
  expect(takeDesktopLinks()).toEqual(["tau://new?prompt=Startup"]);
});
