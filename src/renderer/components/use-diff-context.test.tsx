// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiFileDiff } from "../../shared/workspace-kit-types";
import { diffGaps } from "./diff-context";
import { useDiffContext } from "./use-diff-context";

afterEach(cleanup);

const diff: UiFileDiff = { path: "a.ts", added: 1, removed: 0, hunks: [{ header: "@@ -5 +5 @@", lines: [{ kind: "added", newLine: 5, text: "five" }] }] };
const text = Array.from({ length: 8 }, (_unused, index) => `l${index + 1}`).join("\n") + "\n";

describe("useDiffContext", () => {
  it("reads the file on the first expansion only and keeps what was revealed", async () => {
    const read = vi.fn(async () => text);
    const { result } = renderHook(() => useDiffContext({ read, scope: "pr@1" }));
    expect(result.current.apply(diff)).toEqual({ diff });
    const [start] = diffGaps(diff);
    act(() => result.current.expand(start!, { from: 3, to: 4 }));
    expect(result.current.state("a.ts")).toEqual({ busy: true });
    await waitFor(() => expect(result.current.apply(diff).totalLines).toBe(8));
    expect(result.current.apply(diff).diff.hunks[0]!.lines.map((line) => line.newLine)).toEqual([3, 4, 5]);
    act(() => result.current.expand(diffGaps(result.current.apply(diff).diff)[0]!, { from: 1, to: 2 }));
    expect(result.current.apply(diff).diff.hunks[0]!.lines.map((line) => line.newLine)).toEqual([1, 2, 3, 4, 5]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps the failure where it happened, and reads again on the next click", async () => {
    const read = vi.fn<(path: string) => Promise<string>>().mockRejectedValueOnce(new Error("nope")).mockResolvedValue(text);
    const { result } = renderHook(() => useDiffContext({ read, scope: "pr@1" }));
    const [start] = diffGaps(diff);
    act(() => result.current.expand(start!, { from: 1, to: 4 }));
    await waitFor(() => expect(result.current.state("a.ts")).toEqual({ error: "nope", at: 1 }));
    act(() => result.current.expand(start!, { from: 1, to: 4 }));
    await waitFor(() => expect(result.current.apply(diff).diff.hunks[0]!.lines).toHaveLength(5));
    expect(result.current.state("a.ts")).toBeUndefined();
  });

  it("starts over for another scope, ignores a read that finishes late, and asks `can` for the files it offers", async () => {
    let finish: (value: string) => void = () => undefined;
    const read = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const { result, rerender } = renderHook(({ scope }) => useDiffContext({ read, scope, can: (path) => path !== "gone.ts" }), { initialProps: { scope: "pr@1" } });
    expect(result.current.can("gone.ts")).toBe(false);
    expect(result.current.can("a.ts")).toBe(true);
    act(() => result.current.expand(diffGaps(diff)[0]!, { from: 1, to: 4 }));
    rerender({ scope: "pr@2" });
    await act(async () => { finish(text); await Promise.resolve(); });
    expect(result.current.apply(diff)).toEqual({ diff });
    expect(result.current.state("a.ts")).toBeUndefined();
  });
});
