// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { interactionFiles } from "./file-interaction-test-support.js";
import { useViewedFileRanges } from "./use-review-files.js";

afterEach(cleanup);

describe("viewed range writes", () => {
  it("resets the anchor on a different request, even when the two requests have the same paths", async () => {
    const files = interactionFiles().files;
    const save = vi.fn(async () => undefined);
    const { result, rerender } = renderHook(({ request }) => useViewedFileRanges({ request, files, allowed: true, save, notify: vi.fn() }), { initialProps: { request: "first" } });
    await act(async () => { await result.current.toggle(files[0]!, false); });
    save.mockClear();
    rerender({ request: "second" });
    await act(async () => { await result.current.toggle(files[3]!, true); });
    expect(save.mock.calls).toEqual([["src/d.ts", true]]);
  });

  it("falls back to a single file when the anchor was filtered out", async () => {
    const files = interactionFiles().files;
    const save = vi.fn(async () => undefined);
    const { result, rerender } = renderHook(({ visible }) => useViewedFileRanges({ request: "one", files: visible, allowed: true, save, notify: vi.fn() }), { initialProps: { visible: files } });
    await act(async () => { await result.current.toggle(files[1]!, false); });
    save.mockClear();
    rerender({ visible: files.filter((file) => file.path !== "src/a.test.ts") });
    await act(async () => { await result.current.toggle(files[3]!, true); });
    expect(save.mock.calls).toEqual([["src/d.ts", true]]);
  });

  it("refuses read-only changes and overlapping range writes", async () => {
    const files = interactionFiles().files;
    let finish!: () => void;
    const save = vi.fn((_path: string, _viewed: boolean) => new Promise<void>((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ allowed }) => useViewedFileRanges({ request: "one", files, allowed, save, notify: vi.fn() }), { initialProps: { allowed: false } });
    await act(async () => { await result.current.toggle(files[0]!, true); });
    expect(save).not.toHaveBeenCalled();
    rerender({ allowed: true });
    let update!: Promise<void>;
    act(() => { update = result.current.toggle(files[0]!, false); });
    expect(result.current.busy).toBe(true);
    expect(result.current.isViewed(files[0]!)).toBe(true);
    await act(async () => { await result.current.toggle(files[3]!, true); });
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); await update; });
    expect(result.current.busy).toBe(false);
  });
});
