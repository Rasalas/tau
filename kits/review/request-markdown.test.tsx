// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "tau";
import { RequestMarkdown, RequestMediaProvider } from "./request-markdown.js";
import type { PullRequestRef } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";

const ref: PullRequestRef = { service: "gitlab", host: "gl.here", repo: "root/repro", number: 1, url: "http://gitlab.local/root/repro/-/merge_requests/1" };
const png = "/uploads/e347d7ff85358d19b72222f1174b9a4b/shot.png";
const mp4 = "/uploads/a06b958502b7f0ce1588f2000a7ac2c0/clip.mp4";
const result = (n = 1, mimeType = "image/png") => ({ path: `/resources/${String(n).repeat(64)}`, url: `http://host.test/resources/${String(n).repeat(64)}`, mimeType });
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function draw(text: string, client: Pick<PullRequestClient, "media" | "releaseMedia">, request = ref) {
  return <RequestMediaProvider client={client} request={request}><RequestMarkdown>{text}</RequestMarkdown></RequestMediaProvider>;
}

describe("request Markdown media", () => {
  it("loads the real MR's relative image and MP4 as an image and a seekable player", async () => {
    const client = { media: vi.fn(async (_url, src) => result(src === png ? 1 : 2, src === png ? "image/png" : "video/mp4")), releaseMedia: vi.fn(async () => undefined) };
    const { container, unmount } = render(draw(`Before\n\n![blueprint](${png})\n\nAfter\n\n![playback-test](${mp4})`, client));
    await waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("src")).toBe(result().url);
      expect(container.querySelector("video")?.getAttribute("src")).toBe(result(2).url);
    });
    expect(container.querySelector("video")?.controls).toBe(true);
    expect(container.textContent).toContain("Before"); expect(container.textContent).toContain("After");
    expect(client.media).toHaveBeenCalledWith(ref.url, png); expect(client.media).toHaveBeenCalledWith(ref.url, mp4);
    const video = container.querySelector("video")!;
    unmount(); expect(video.pause).toHaveBeenCalled(); expect(video.getAttribute("src")).toBeNull();
    expect(client.releaseMedia).toHaveBeenCalledWith(result().path); expect(client.releaseMedia).toHaveBeenCalledWith(result(2).path);
  });
  it("keeps GitHub HTML/dimensions and supports nested video sources and copied video links", async () => {
    const client = { media: vi.fn(async (_url, src) => result(1, src.endsWith(".mp4") ? "video/mp4" : "image/png")) };
    const text = `<details><summary>Pictures</summary>\n\n<img src="${png}" alt="shot" width="20" height="30" onerror="alert(1)">\n\n<video controls><source src="${mp4}"></video>\n\n[clip](http://gitlab.local/root/repro${mp4})\n\n</details>`;
    const { container } = render(draw(text, client));
    await waitFor(() => expect(container.querySelectorAll("video")).toHaveLength(2));
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe(result().url));
    expect(container.querySelector("img")?.width).toBe(20); expect(container.querySelector("img")?.height).toBe(30);
    expect(container.querySelector("img")?.getAttribute("onerror")).toBeNull();
    expect(container.querySelector("details")?.open).toBe(false);
  });
  it("coalesces identical media within one request", async () => {
    const client = { media: vi.fn(async () => result()) };
    const { container } = render(draw(`![one](${png}) ![two](${png})`, client));
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(2));
    expect(client.media).toHaveBeenCalledTimes(1);
  });
  it("retries with a newly minted capability", async () => {
    const client = { media: vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce(result(2)) };
    const { container, findByRole } = render(draw(`![shot](${png})`, client));
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe(result().url));
    fireEvent.error(container.querySelector("img")!);
    fireEvent.click(await findByRole("button", { name: "Retry upload" }));
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe(result(2).url));
    expect(client.media).toHaveBeenCalledTimes(2);
  });
  it("falls back to original public GitHub images when signed delivery fails", async () => {
    const github = { ...ref, service: "github" as const, host: "github.com", url: "https://github.com/owner/repo/pull/1" };
    const src = "https://github.com/user-attachments/assets/1234-abcd";
    const client = { media: vi.fn(async () => result()) };
    const { container } = render(draw(`<img src="${src}" width="20">`, client, github));
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe(result().url));
    fireEvent.error(container.querySelector("img")!);
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe(src));
    expect(container.querySelector("img")?.width).toBe(20);
  });
  it("resolves a public GitLab upload's fallback against the project, not the app", async () => {
    const request = { ...ref, url: "https://gitlab.example/root/repro/-/merge_requests/1" };
    const client = { media: vi.fn(async () => { throw new Error("Host unavailable"); }) };
    const { container } = render(draw(`![shot](${png})`, client, request));
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe(`https://gitlab.example/root/repro${png}`));
  });
  it("renders a bare GitHub video upload URL through authenticated delivery", async () => {
    const github = { ...ref, service: "github" as const, host: "github.com", url: "https://github.com/owner/repo/pull/1" };
    const src = "https://github.com/user-attachments/assets/1234-abcd";
    const client = { media: vi.fn(async () => result()) };
    const { container } = render(draw(src, client, github));
    await waitFor(() => expect(container.querySelector("video")?.getAttribute("src")).toBe(result().url));
    expect(container.querySelector("video")?.controls).toBe(true);
    expect(client.media).toHaveBeenCalledWith(github.url, src);
  });
  it("never authenticates ordinary web images or unsafe HTML", () => {
    const client = { media: vi.fn(async () => result()) };
    const { container } = render(draw('![public](https://example.com/a.png)\n\n<video src="javascript:alert(1)"></video><img src="file:///secret"><script>alert(1)</script>', client));
    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://example.com/a.png");
    expect(container.querySelector("video")).toBeNull(); expect(container.querySelector("script")).toBeNull();
    expect(client.media).not.toHaveBeenCalled();
  });
  it("revokes a capability that arrives after closing the request", async () => {
    let finish!: (value: ReturnType<typeof result>) => void;
    const client = { media: vi.fn(() => new Promise<ReturnType<typeof result>>((resolve) => { finish = resolve; })), releaseMedia: vi.fn(async () => undefined) };
    const { unmount } = render(draw(`![shot](${png})`, client));
    await waitFor(() => expect(client.media).toHaveBeenCalled()); unmount(); finish(result());
    await waitFor(() => expect(client.releaseMedia).toHaveBeenCalledWith(result().path));
  });
  it("retains core tag renderers while overriding an image, including streamed Markdown", () => {
    const components = { img: () => <span>Feature image</span> };
    const { container, rerender } = render(<Markdown components={components}>{'![image](a.png)\n\n```js\nlet a = 1;\n```'}</Markdown>);
    expect(container.textContent).toContain("Feature image"); expect(container.querySelector(".md-code")).toBeTruthy();
    rerender(<Markdown streaming components={components}>{'![image](a.png)\n\nNext'}</Markdown>);
    expect(container.textContent).toContain("Feature image");
  });
});
