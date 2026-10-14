// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { LIST_PAINT_MARK, observeListPaint } from "./dev-measure";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "checkVisibility");
  Reflect.deleteProperty(document, "elementFromPoint");
  document.body.innerHTML = "";
});

it("records the data-bearing list after a frame and a task, rather than its empty shell", async () => {
  const mark = vi.fn();
  vi.stubGlobal("performance", { mark });
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frame = callback; return 1; });
  Object.defineProperty(HTMLElement.prototype, "checkVisibility", { configurable: true, value: () => true });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 44, left: 0, right: 100, top: 0, bottom: 44, x: 0, y: 0, toJSON: () => ({}) });
  const hit = vi.fn();
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hit });
  document.body.innerHTML = '<section class="touch-browser home"></section>';
  observeListPaint();
  await Promise.resolve();
  expect(frame).toBeUndefined();
  const row = document.createElement("button");
  row.className = "touch-thread-open";
  row.disabled = true;
  hit.mockReturnValue(row);
  document.querySelector("section")!.append(row);
  await Promise.resolve();
  expect(frame).toBeUndefined();
  row.disabled = false;
  await Promise.resolve();
  expect(frame).toBeTypeOf("function");
  expect(mark).not.toHaveBeenCalled();
  frame!(0);
  await new Promise((done) => setTimeout(done, 5));
  expect(mark).toHaveBeenCalledExactlyOnceWith(LIST_PAINT_MARK);
});
