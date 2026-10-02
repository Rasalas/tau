// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Markdown";
import { WorkspaceResourceProvider } from "../workspace-resource-context";
import { WorkbenchContext, type WorkbenchContextValue } from "../workbench-context";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import type { UiFileContent } from "../../shared/workspace-kit-types";

const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const image = (path = "a.png"): UiFileContent => ({ path, name: path, size: 68, kind: "image", dataUrl });
afterEach(cleanup);

function fixture(load = vi.fn().mockResolvedValue(image())) {
  const source = { id: "workspace", loadFile: load };
  const workbench = { registry: { getDocumentSource: () => source }, openWorkspaceFile: vi.fn() } as unknown as WorkbenchContextValue;
  const client = createFakeHostClient();
  const draw = (text = "![Screenshot](a.png)", workspace: string | undefined = "ws-A", streaming = false, host = client) =>
    <HostClientProvider client={host}><WorkbenchContext.Provider value={workbench}>
      <WorkspaceResourceProvider sessionId="thread" workspace={workspace}><Markdown streaming={streaming}>{text}</Markdown></WorkspaceResourceProvider>
    </WorkbenchContext.Provider></HostClientProvider>;
  return { load, draw, client };
}

function deferred() {
  let resolve!: (value: UiFileContent) => void;
  const promise = new Promise<UiFileContent>((done) => { resolve = done; });
  return { promise, resolve };
}

async function hasImage(container: HTMLElement, expected = dataUrl) {
  await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe(expected));
}

describe("workspace Markdown images", () => {
  it("reads a dot path through the bound source and does not refetch for unrelated stream updates or settling", async () => {
    const { draw, load } = fixture();
    const text = "![Screenshot](.tau-dev/dictation-preview/recording-detail.png)\n\n";
    const { container, rerender } = render(draw(text, "ws-A", true));
    await hasImage(container);
    for (const suffix of ["Next", "Next sentence", "Next sentence."]) rerender(draw(text + suffix, "ws-A", true));
    rerender(draw(text + "Next sentence.", "ws-A", false));
    await hasImage(container);
    expect(load.mock.calls).toEqual([[".tau-dev/dictation-preview/recording-detail.png", { workspace: "ws-A" }]]);
  });

  it("discards a delayed path result and clears the old bytes immediately", async () => {
    const old = deferred();
    const next = deferred();
    const { draw } = fixture(vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise).mockReturnValue(deferred().promise));
    const { container, rerender } = render(draw());
    rerender(draw("![Next](b.png)"));
    await act(async () => old.resolve(image()));
    expect(container.querySelector("img")).toBeNull();
    await act(async () => next.resolve(image("b.png")));
    await hasImage(container);
    rerender(draw("![Third](c.png)"));
    expect(container.querySelector("img")).toBeNull();
  });

  it("ignores completion after unmount", async () => {
    const pending = deferred();
    const { draw, load } = fixture(vi.fn().mockReturnValue(pending.promise));
    const { container, unmount } = render(draw());
    unmount();
    await act(async () => pending.resolve(image()));
    expect(container.childElementCount).toBe(0);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("separates two origins sharing a path", async () => {
    const a = deferred();
    const b = deferred();
    const { draw, load } = fixture(vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise));
    const { container, rerender } = render(draw());
    rerender(draw("![Screenshot](a.png)", "ws-B"));
    await act(async () => a.resolve(image()));
    expect(container.querySelector("img")).toBeNull();
    await act(async () => b.resolve(image()));
    await hasImage(container);
    expect(load.mock.calls.map((call) => call[1])).toEqual([{ workspace: "ws-A" }, { workspace: "ws-B" }]);
  });

  it("drops old-host results after connection replacement", async () => {
    const a = deferred();
    const b = deferred();
    const { draw } = fixture(vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise));
    const { container, rerender } = render(draw());
    rerender(draw("![Screenshot](a.png)", "ws-A", false, createFakeHostClient()));
    await act(async () => a.resolve(image()));
    expect(container.querySelector("img")).toBeNull();
    await act(async () => b.resolve(image()));
    await hasImage(container);
  });

  for (const [message, guidance] of [["Unknown workspace", "not found"], ["File not found", "not found"], ["Access denied", "denied"], ["Host offline", "offline"], ["Image exceeds size limit", "too large"]]) {
    it(`draws accessible guidance for ${message}`, async () => {
      const { draw } = fixture(vi.fn().mockRejectedValue(new Error(message)));
      const { container, findByRole } = render(draw());
      const fallback = await findByRole("img", { name: new RegExp(`Screenshot: .*${guidance}`) });
      expect(fallback.tagName).toBe("SPAN");
      expect(container.querySelector("img")).toBeNull();
    });
  }

  for (const file of [{ ...image(), kind: "text" as const, text: "not an image" }, { ...image(), truncated: true }, { ...image(), dataUrl: "file:///host/a.png" }]) {
    it(`refuses unsupported image bytes ${JSON.stringify(file)}`, async () => {
      const { draw } = fixture(vi.fn().mockResolvedValue(file));
      const { findByRole, container } = render(draw());
      await findByRole("img", { name: /Screenshot: .*not a supported image/ });
      expect(container.querySelector("img")).toBeNull();
    });
  }

  it("shows decode failures instead of a broken image", async () => {
    const { draw } = fixture();
    const { container, findByRole } = render(draw());
    await hasImage(container);
    fireEvent.error(container.querySelector("img")!);
    await findByRole("img", { name: /Screenshot: .*could not be decoded/ });
    expect(container.querySelector("img")).toBeNull();
  });

  it("never falls back to the active project when origin becomes unavailable", async () => {
    const { draw, load } = fixture();
    const { container, rerender, findByRole } = render(draw());
    await hasImage(container);
    rerender(draw("![Screenshot](a.png)", ""));
    await findByRole("img", { name: /Screenshot: .*unavailable/ });
    expect(container.querySelector("img")).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  for (const path of ["../a.png", "/host/a.png", "file:///host/a.png", "javascript:alert(1)", "//host/a.png", "a%2F..%2Fb.png"]) {
    it(`does not read or render unsafe path ${path}`, () => {
      const { draw, load } = fixture();
      const { container } = render(draw(`![Screenshot](${path})`));
      expect(container.querySelector("img")).toBeNull();
      expect(load).not.toHaveBeenCalled();
    });
  }

  it("preserves external HTTPS and inert HTML without workspace reads", () => {
    const { draw, load } = fixture();
    const { container } = render(draw('![External](https://example.com/image.png "Title")\n\n<img src="file:///secret">'));
    expect(container.querySelector("img")?.outerHTML).toBe('<img alt="External" title="Title" src="https://example.com/image.png">');
    expect(container.textContent).toContain('<img src="file:///secret">');
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps allowed raster data images from an HTML policy and does not relax Markdown URL filtering", () => {
    const { container, rerender } = render(<Markdown html={() => ({ type: "root", children: [{ type: "element", tagName: "img", properties: { src: dataUrl, alt: "Inline image" }, children: [] }] })}>{"policy image"}</Markdown>);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(dataUrl);
    rerender(<Markdown>{`![Inline image](${dataUrl})`}</Markdown>);
    expect(container.querySelector("img")).toBeNull();
  });

  it("preserves legacy HTTP images", () => {
    const { draw, load } = fixture();
    const { container } = render(draw("![External](http://example.com/image.png)"));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("http://example.com/image.png");
    expect(load).not.toHaveBeenCalled();
  });

  it("names a missing-alt image by its filename without a resource provider", () => {
    const { getByRole } = render(<Markdown>{"![](.tau-dev/missing.png)"}</Markdown>);
    expect(getByRole("img", { name: /missing.png: .*unavailable/ })).toBeTruthy();
  });
});
