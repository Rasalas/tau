// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiFileDiff } from "../../shared/workspace-kit-types";
import { useDiffFind } from "./use-diff-find";

afterEach(cleanup);

const diffs: UiFileDiff[] = ["a.ts", "b.ts"].map((path) => ({ path, added: 1, removed: 0, hunks: [{ header: "", lines: [{ kind: "added", newLine: 1, text: `${path} has a needle` }] }] }));
const key = (init: Partial<KeyboardEvent>) => ({ key: "f", metaKey: true, altKey: false, shiftKey: false, ctrlKey: false, defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...init }) as unknown as React.KeyboardEvent;

describe("useDiffFind", () => {
  it("opens on Cmd+F or Ctrl+F only, and finds nothing while closed", () => {
    const { result } = renderHook(() => useDiffFind({ diffs }));
    for (const event of [key({ metaKey: false }), key({ key: "g" }), key({ shiftKey: true }), key({ altKey: true })]) act(() => result.current.onKeyDown(event));
    expect(result.current.open).toBe(false);
    const open = key({});
    act(() => result.current.onKeyDown(open));
    expect(open.preventDefault).toHaveBeenCalled();
    expect(result.current.open).toBe(true);
    act(() => result.current.close());
    act(() => result.current.onKeyDown(key({ metaKey: false, ctrlKey: true })));
    expect(result.current.open).toBe(true);
  });

  it("steps through the matches in both directions, wraps, and tells the surface which one is active", () => {
    const onReveal = vi.fn();
    const { result } = renderHook(() => useDiffFind({ diffs, onReveal }));
    act(() => result.current.show());
    act(() => result.current.setQuery({ text: "needle" }));
    expect(result.current.matches).toHaveLength(2);
    expect(result.current.index).toBe(0);
    expect(onReveal).toHaveBeenLastCalledWith(expect.objectContaining({ path: "a.ts" }));
    act(() => result.current.step(1));
    expect(onReveal).toHaveBeenLastCalledWith(expect.objectContaining({ path: "b.ts" }));
    act(() => result.current.step(1));
    expect(result.current.index).toBe(0);
    act(() => result.current.step(-1));
    expect(result.current.index).toBe(1);
    expect(result.current.find?.active?.path).toBe("b.ts");
    act(() => result.current.setQuery({ text: "nothing" }));
    expect(result.current.index).toBe(-1);
    expect(result.current.find).toBeUndefined();
  });
});
