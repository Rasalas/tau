// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import DiffStackScenario from "./RendererBenchmarkDiffStack";

vi.mock("./components/DiffStack", () => ({ DiffStack: () => null }));
afterEach(() => vi.unstubAllGlobals());

it("retries a temporarily missing card and finishes once its rows mount", () => {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  const tick = () => act(() => {
    const current = [...frames.entries()];
    frames.clear();
    for (const [, callback] of current) callback(0);
  });
  const finished = vi.fn();
  const { container, unmount } = render(<DiffStackScenario files={1} lines={1} onFinished={finished} />);
  tick();
  expect(frames.size).toBe(1);
  expect(finished).not.toHaveBeenCalled();
  const card = document.createElement("div");
  card.dataset.path = "src/file-0.ts";
  card.scrollIntoView = vi.fn();
  card.innerHTML = '<div class="diff-row"></div>';
  container.querySelector(".benchmark-diff-stack")!.append(card);
  tick();
  expect(card.scrollIntoView).toHaveBeenCalledOnce();
  tick();
  expect(finished).toHaveBeenCalledExactlyOnceWith(1);
  unmount();
  expect(frames.size).toBe(0);
  // oxlint-disable-next-line eslint/no-underscore-dangle -- Verify cleanup of the cross-process diagnostic.
  expect((window as typeof window & { __TAU_DIFF_STACK_PROGRESS__?: unknown }).__TAU_DIFF_STACK_PROGRESS__).toBeUndefined();
});
