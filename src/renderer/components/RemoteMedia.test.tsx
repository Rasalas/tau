// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Element as HastElement } from "hast";
import { Markdown } from "./Markdown";
import type { MarkdownHtml } from "./markdown-pipeline";
import { ToolMedia } from "./ToolMedia";
import { WorkspaceResourceProvider } from "../workspace-resource-context";
import { WorkbenchContext, type WorkbenchContextValue } from "../workbench-context";
import type { UiToolRun } from "../../shared/contracts";

afterEach(cleanup);

const dataVideo = "data:video/mp4;base64,AAAA";
const dataAudio = "data:audio/wav;base64,AAAA";
const dataImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

function fixture() {
  const release = vi.fn();
  const loadMedia = vi.fn(async () => ({ url: "https://host.test/resources/clip", mimeType: "video/mp4", release }));
  const source = { id: "workspace", loadFile: vi.fn(), loadMedia };
  const workbench = { registry: { getDocumentSource: () => source }, openWorkspaceFile: vi.fn() } as unknown as WorkbenchContextValue;
  const draw = (text: string, html?: MarkdownHtml) =>
    <WorkbenchContext.Provider value={workbench}>
      <WorkspaceResourceProvider sessionId="thread" workspace="ws-A"><Markdown html={html}>{text}</Markdown></WorkspaceResourceProvider>
    </WorkbenchContext.Provider>;
  return { draw, loadMedia, workbench };
}

const video = (properties: HastElement["properties"], children: HastElement["children"] = []): MarkdownHtml =>
  () => ({ type: "root", children: [{ type: "element", tagName: "video", properties, children }] });

const tool = (media: UiToolRun["media"]): UiToolRun => ({ id: "call", name: "screenshot", status: "done", media } as unknown as UiToolRun);

describe("remote video from Markdown", () => {
  it("draws no video until the reader clicks, then loads exactly that address", async () => {
    const src = "https://example.com/clip.mp4?d=secret";
    const { draw } = fixture();
    const { container, findByRole } = render(draw(`![Recording](${src})`));
    const placeholder = await findByRole("button", { name: "Load video from example.com" });
    expect(placeholder.className).toBe("md-remote-image");
    expect(placeholder.textContent).toBe("Recording · Load video from example.com");
    expect(container.querySelector("video")).toBeNull();
    fireEvent.click(placeholder);
    expect(container.querySelectorAll("video")).toHaveLength(1);
    expect(container.querySelector("video")?.getAttribute("src")).toBe(src);
  });

  it("asks again when the address changes, including when it returns to an earlier one", () => {
    const first = "https://example.com/clip.mp4?d=first";
    const next = "https://example.com/clip.mp4?d=next";
    const { draw } = fixture();
    const { container, rerender, getByRole } = render(draw(`![](${first})`));
    fireEvent.click(getByRole("button", { name: "Load video from example.com" }));
    expect(container.querySelector("video")?.getAttribute("src")).toBe(first);
    for (const src of [next, first]) {
      rerender(draw(`![](${src})`));
      fireEvent.click(getByRole("button", { name: "Load video from example.com" }));
      expect(container.querySelector("video")?.getAttribute("src")).toBe(src);
    }
    rerender(draw(`![](${next})`));
    expect(container.querySelector("video")).toBeNull();
  });

  it("keeps a blocked video out of the message's gallery", async () => {
    const { draw } = fixture();
    const { container, findByRole } = render(draw("![Clip](clips/demo.mp4)\n\n![](https://example.com/clip.mp4)"));
    await findByRole("button", { name: "Load video from example.com" });
    fireEvent.click(await findByRole("button", { name: "Open video 1" }));
    const dialog = await findByRole("dialog");
    expect(dialog.querySelector("video")?.getAttribute("src")).toBe("https://host.test/resources/clip");
    expect(dialog.querySelector('[aria-label="Next media"]')).toBeNull();
    expect(container.querySelector('video[src^="https://example.com"]')).toBeNull();
  });

  it("does not follow the link around a linked remote video when granting consent", async () => {
    const { draw, workbench } = fixture();
    const { container, findByRole } = render(draw("[![Clip](https://example.com/clip.mp4)](a.png)"));
    fireEvent.click(await findByRole("button", { name: "Load video from example.com" }));
    expect(container.querySelector("video")?.getAttribute("src")).toBe("https://example.com/clip.mp4");
    expect(workbench.openWorkspaceFile).not.toHaveBeenCalled();
  });

  it("loads workspace videos and data videos without a click", async () => {
    const { draw, loadMedia } = fixture();
    const { container } = render(draw("![Clip](clips/demo.mp4)"));
    await waitFor(() => expect(container.querySelector("video")?.getAttribute("src")).toBe("https://host.test/resources/clip"));
    expect(loadMedia).toHaveBeenCalledWith("clips/demo.mp4", { workspace: "ws-A" });
    expect(container.querySelector("button.md-remote-image")).toBeNull();
    cleanup();
    const data = render(draw("policy video", video({ src: dataVideo, title: "Inline" })));
    expect(data.container.querySelector("video")?.getAttribute("src")).toBe(dataVideo);
    expect(data.container.querySelector("button.md-remote-image")).toBeNull();
  });

  it("waits for a click on a policy's video and never draws its poster or sources", async () => {
    const src = "https://example.com/clip.mp4";
    const source: HastElement = { type: "element", tagName: "source", properties: { src: "https://tracker.example/other.mp4" }, children: [] };
    const { draw } = fixture();
    const { container, findByRole } = render(draw("policy video", video({ src, poster: "https://tracker.example/poster.jpg", title: "Demo" }, [source])));
    const placeholder = await findByRole("button", { name: "Load video from example.com" });
    expect(placeholder.textContent).toBe("Demo · Load video from example.com");
    expect(container.querySelector("video, source, [poster]")).toBeNull();
    fireEvent.click(placeholder);
    expect(container.querySelector("video")?.getAttribute("src")).toBe(src);
    expect(container.querySelector("[poster], source")).toBeNull();
  });

  it("draws nothing for a policy's video that names no address", () => {
    const { draw } = fixture();
    const { container } = render(draw("policy video", video({ poster: "https://tracker.example/poster.jpg" })));
    expect(container.querySelector("video, [poster], button.md-remote-image")).toBeNull();
  });
});

describe("remote media in a tool result", () => {
  it("holds a remote image behind a click and keeps it out of the gallery", () => {
    const src = "https://example.com/shot.png?d=secret";
    const { container, getByRole, queryByRole } = render(<ToolMedia tool={tool([{ type: "image", url: src }])} />);
    expect(container.querySelector("img")).toBeNull();
    expect(queryByRole("button", { name: "Open image 1" })).toBeNull();
    const placeholder = getByRole("button", { name: "Load image from example.com" });
    expect(placeholder.className).toBe("md-remote-image");
    fireEvent.click(placeholder);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(src);
  });

  it("asks again for another image address", () => {
    const { container, getByRole, rerender } = render(<ToolMedia tool={tool([{ type: "image", url: "https://example.com/a.png" }])} />);
    fireEvent.click(getByRole("button", { name: "Load image from example.com" }));
    rerender(<ToolMedia tool={tool([{ type: "image", url: "https://example.com/b.png" }])} />);
    expect(container.querySelector("img")).toBeNull();
    expect(getByRole("button", { name: "Load image from example.com" })).toBeTruthy();
  });

  it("shows a data image in the gallery at once, beside a blocked remote one", () => {
    const { container, getByRole, queryByRole } = render(<ToolMedia tool={tool([{ type: "image", url: dataImage }, { type: "image", url: "https://example.com/b.png" }])} />);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(dataImage);
    expect(getByRole("button", { name: "Open image 1" })).toBeTruthy();
    expect(queryByRole("button", { name: "Open image 2" })).toBeNull();
    expect(getByRole("button", { name: "Load image from example.com" })).toBeTruthy();
  });

  it("holds a remote video behind a click and keeps it out of the gallery", () => {
    const { container, getByRole, queryByRole } = render(<ToolMedia tool={tool([{ type: "video", url: "https://example.com/clip.mp4" }])} />);
    expect(container.querySelector("video")).toBeNull();
    expect(queryByRole("button", { name: "Open video 1" })).toBeNull();
    fireEvent.click(getByRole("button", { name: "Load video from example.com" }));
    expect(container.querySelector("video")?.getAttribute("src")).toBe("https://example.com/clip.mp4");
  });

  it("holds remote audio behind a click and plays exactly that address", () => {
    const src = "https://example.com/a.mp3?d=secret";
    const { container, getByRole } = render(<ToolMedia tool={tool([{ type: "audio", url: src }])} />);
    expect(container.querySelector("audio")).toBeNull();
    const placeholder = getByRole("button", { name: "Load audio from example.com" });
    expect(placeholder.className).toBe("md-remote-image");
    fireEvent.click(placeholder);
    expect(container.querySelector("audio")?.getAttribute("src")).toBe(src);
    expect(container.querySelector("audio")?.controls).toBe(true);
  });

  it("asks again for another audio address", () => {
    const { container, getByRole, rerender } = render(<ToolMedia tool={tool([{ type: "audio", url: "https://example.com/a.mp3" }])} />);
    fireEvent.click(getByRole("button", { name: "Load audio from example.com" }));
    rerender(<ToolMedia tool={tool([{ type: "audio", url: "https://example.com/b.mp3" }])} />);
    expect(container.querySelector("audio")).toBeNull();
    expect(getByRole("button", { name: "Load audio from example.com" })).toBeTruthy();
  });

  it("plays data audio and data video without a click", () => {
    const { container } = render(<ToolMedia tool={tool([{ type: "audio", url: dataAudio }, { type: "video", url: dataVideo }])} />);
    expect(container.querySelector("audio")?.getAttribute("src")).toBe(dataAudio);
    expect(container.querySelector("video")?.getAttribute("src")).toBe(dataVideo);
    expect(container.querySelector("button.md-remote-image")).toBeNull();
  });
});
