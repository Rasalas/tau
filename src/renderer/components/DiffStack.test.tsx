// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiFileDiff } from "../../shared/workspace-kit-types";
import { DiffStack, type StackFile } from "./DiffStack";

const observers: Array<{ callback: IntersectionObserverCallback; margin: string; targets: Element[] }> = [];

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", class {
    readonly record: (typeof observers)[number];
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
      this.record = { callback, margin: options.rootMargin ?? "", targets: [] };
      observers.push(this.record);
    }
    observe(target: Element) { this.record.targets.push(target); }
    disconnect() { this.record.targets = []; }
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function diff(path: string, count = 150): UiFileDiff {
  return { path, added: count, removed: 0, hunks: [{ header: `@@ -0,0 +1,${count} @@`, lines: Array.from({ length: count }, (_, index) => ({ kind: "added", newLine: index + 1, text: `line ${index}` })) }] };
}

function setup(count = 2, props: Partial<Parameters<typeof DiffStack>[0]> = {}) {
  const files: StackFile[] = Array.from({ length: count }, (_, index) => ({ path: `file-${index}.txt`, added: 150, removed: 0 }));
  const diffs = new Map(files.map((file) => [file.path, diff(file.path)]));
  const scroll = createRef<HTMLDivElement>();
  const renderStack = (overrides = props) => <div ref={scroll}><DiffStack files={files} diffs={diffs} scroll={scroll} layout="unified" wrap {...overrides} /></div>;
  const result = render(renderStack());
  const near = observers.find((observer) => observer.margin === "900px 0px")!;
  const regions = Array.from(result.container.querySelectorAll<HTMLElement>("[data-stack-file]"));
  const visibility = (entries: Array<[number, boolean]>) => act(() => near.callback(entries.map(([index, isIntersecting]) => ({ target: regions[index]!, isIntersecting })) as unknown as IntersectionObserverEntry[], {} as IntersectionObserver));
  return { ...result, files, regions, visibility, renderStack };
}

describe("DiffStack", () => {
  it("releases distant diffs and keeps the measured body height when revisiting", async () => {
    const { regions, visibility } = setup();
    visibility([[0, true]]);
    await waitFor(() => expect(regions[0]!.querySelector(".diff-stream")).toBeTruthy());
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 3612 } as DOMRect);
    visibility([[0, false], [1, true]]);
    await waitFor(() => expect(regions[0]!.querySelector(".diff-stream")).toBeNull());
    expect(regions[0]!.querySelector<HTMLElement>("[aria-hidden=true][style]")!.style.height).toBe("3612px");
    visibility([[1, false], [0, true]]);
    await waitFor(() => expect(regions[0]!.querySelector(".diff-stream")).toBeTruthy());
    expect(regions[0]!.querySelector("[aria-hidden=true][style]")).toBeNull();
  });

  it("bounds mounted diffs and DOM nodes after scrolling all 300 files of 150 lines", async () => {
    const { container, files, regions, visibility } = setup(300);
    const windowSize = 10;
    let previous: number[] = [];
    // Mount every file, with fewer full-stack updates than a one-file scroll step.
    for (let start = 0; start < files.length; start += windowSize) {
      const current = Array.from({ length: Math.min(windowSize, files.length - start) }, (_, offset) => start + offset);
      visibility([...previous.map((index): [number, boolean] => [index, false]), ...current.map((index): [number, boolean] => [index, true])]);
      // Each viewport must commit before the next observer notification.
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => {
        const mounted = Array.from(container.querySelectorAll(".diff-stream"), (stream) => stream.closest<HTMLElement>("[data-stack-file]")!.dataset.path);
        expect(mounted).toEqual(current.map((index) => files[index]!.path));
        for (const index of current) expect(regions[index]!.querySelector(".diff-row")).toBeTruthy();
      });
      expect(container.querySelectorAll(".diff-row").length).toBeLessThanOrEqual(150 * current.length);
      expect(container.querySelectorAll("*").length).toBeLessThan(10_000);
      previous = current;
    }
    visibility(previous.slice(0, -1).map((index) => [index, false]));
    await waitFor(() => expect(container.querySelectorAll(".diff-stream")).toHaveLength(1));
    expect(container.querySelectorAll(".diff-row").length).toBeLessThanOrEqual(150);
    expect(container.querySelectorAll("*").length).toBeLessThan(10_000);
    visibility([[299, false]]);
    await waitFor(() => expect(container.querySelectorAll(".diff-stream")).toHaveLength(0));
  });

  it("unmounts custom bodies too, then unfolds and mounts a distant jump target", async () => {
    const body = (file: StackFile) => <p data-custom-body>{file.path} body</p>;
    const { regions, visibility, rerender, renderStack } = setup(2, { body });
    expect(regions[0]!.querySelector("[data-custom-body]")).toBeNull();
    visibility([[0, true]]);
    await waitFor(() => expect(regions[0]!.querySelector("[data-custom-body]")).toBeTruthy());
    fireEvent.click(regions[0]!.querySelector("button")!);
    visibility([[0, false]]);
    rerender(renderStack({ body, jump: { path: "file-0.txt", at: 1 } }));
    await waitFor(() => expect(regions[0]!.querySelector("[data-custom-body]")).toBeTruthy());
    visibility([[0, false], [1, true]]);
    await waitFor(() => expect(regions[0]!.querySelector("[data-custom-body]")).toBeNull());
  });

  it("discards an evicted lazy read and reads the current version on return", async () => {
    let resolveFirst!: (answer: UiFileDiff) => void;
    const read = vi.fn().mockImplementationOnce(() => new Promise<UiFileDiff>((resolve) => { resolveFirst = resolve; })).mockResolvedValue(diff("file-0.txt", 1));
    const { regions, visibility, rerender, renderStack } = setup(1, { diffs: undefined, read, version: "first" });
    visibility([[0, true]]);
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    visibility([[0, false]]);
    await act(async () => resolveFirst(diff("file-0.txt")));
    await waitFor(() => expect(regions[0]!.querySelector(".diff-stream")).toBeNull());
    rerender(renderStack({ diffs: undefined, read, version: "second" }));
    visibility([[0, true]]);
    await waitFor(() => expect(regions[0]!.querySelector(".diff-row")).toBeTruthy());
    expect(read).toHaveBeenCalledTimes(2);
  });
});
