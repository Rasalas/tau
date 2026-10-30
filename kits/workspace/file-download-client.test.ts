import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadWorkspaceFile } from "./file-download-client.js";
import { FILE_DOWNLOAD_MAX_BYTES } from "./protocol.js";

afterEach(() => { vi.unstubAllGlobals(); });
const path = `/resources/${"a".repeat(64)}`;
function fixture() {
  const host = {
    publishFileDownload: vi.fn(async () => ({ path, name: "a.docx", size: 3 })),
    releaseFileDownload: vi.fn(async () => undefined),
  };
  const resourceUrl = vi.fn(() => `https://machine.invalid${path}`);
  return { host, resourceUrl, signal: new AbortController().signal };
}
describe("file download over the connected machine's browser resources", () => {
  it("keeps the explicit origin on publication and release and checks all bytes before returning a Blob", async () => {
    const { host, resourceUrl, signal } = fixture();
    const fetcher = vi.fn(async () => new Response(new Uint8Array([0, 1, 255]))); vi.stubGlobal("fetch", fetcher);
    const result = await downloadWorkspaceFile(host, resourceUrl, "a.docx", { workspace: "ws1_original" }, signal);
    expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(new Uint8Array([0, 1, 255]));
    expect(result.blob.type).toBe("application/octet-stream");
    expect(host.publishFileDownload).toHaveBeenCalledWith("a.docx", "ws1_original");
    expect(host.releaseFileDownload).toHaveBeenCalledExactlyOnceWith(path, "ws1_original");
    expect(resourceUrl).toHaveBeenCalledWith(path);
    expect(fetcher).toHaveBeenCalledWith(`https://machine.invalid${path}`, expect.objectContaining({ credentials: "omit", redirect: "error" }));
  });
  it.each([502, "short", "long", "network"])("releases the resource after transfer failure %s", async (failure) => {
    const { host, resourceUrl, signal } = fixture();
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (failure === "network") throw new Error("Connection lost");
      return new Response(new Uint8Array(failure === "long" ? 4 : 2), { status: typeof failure === "number" ? failure : 200 });
    }));
    await expect(downloadWorkspaceFile(host, resourceUrl, "a.docx", { workspace: "ws1_origin" }, signal)).rejects.toThrow();
    expect(host.releaseFileDownload).toHaveBeenCalledExactlyOnceWith(path, "ws1_origin");
  });
  it("releases a capability returned after unmount/abort without fetching it", async () => {
    const { host, resourceUrl } = fixture(); const controller = new AbortController();
    host.publishFileDownload.mockImplementation(async () => { controller.abort(); return { path, name: "a.docx", size: 3 }; });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(downloadWorkspaceFile(host, resourceUrl, "a.docx", { workspace: "ws1_origin" }, controller.signal)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled(); expect(host.releaseFileDownload).toHaveBeenCalledOnce();
  });
  it("cancels an active transfer and releases on the captured origin after the caller changes projects", async () => {
    const { host, resourceUrl } = fixture(); const controller = new AbortController();
    const from = { workspace: "ws1_origin" };
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ pull() { started(); }, cancel }))));
    const pending = downloadWorkspaceFile(host, resourceUrl, "a.docx", from, controller.signal);
    const failure = expect(pending).rejects.toThrow();
    await reading; from.workspace = "ws1_different"; controller.abort();
    await failure;
    expect(cancel).toHaveBeenCalledOnce();
    expect(host.releaseFileDownload).toHaveBeenCalledExactlyOnceWith(path, "ws1_origin");
  });
  it("does not fetch native resource routes without a general platform save port", async () => {
    const { host, resourceUrl, signal } = fixture(); resourceUrl.mockReturnValue(`tau-resource://localhost/connection${path}`);
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(downloadWorkspaceFile(host, resourceUrl, "a.docx", { workspace: "ws1_origin" }, signal)).rejects.toThrow("cannot save");
    expect(fetcher).not.toHaveBeenCalled(); expect(host.releaseFileDownload).toHaveBeenCalledOnce();
  });
  it("refuses metadata beyond the transport budget without fetching and still releases", async () => {
    const { host, resourceUrl, signal } = fixture();
    host.publishFileDownload.mockResolvedValue({ path, name: "a.zip", size: FILE_DOWNLOAD_MAX_BYTES + 1 });
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(downloadWorkspaceFile(host, resourceUrl, "a.zip", { workspace: "ws1_origin" }, signal)).rejects.toThrow("10 MiB");
    expect(fetcher).not.toHaveBeenCalled(); expect(host.releaseFileDownload).toHaveBeenCalledOnce();
  });
  it("explains older machines without trying an absolute-path or public-URL fallback", async () => {
    const { host, resourceUrl, signal } = fixture();
    host.publishFileDownload.mockRejectedValue(Object.assign(new Error("Unknown command"), { code: "unknown-command" }));
    await expect(downloadWorkspaceFile(host, resourceUrl, "/machine/project/a.docx", { workspace: "ws1_origin" }, signal)).rejects.toThrow("Update Tau");
    expect(resourceUrl).not.toHaveBeenCalled(); expect(host.releaseFileDownload).not.toHaveBeenCalled();
    await expect(downloadWorkspaceFile(host, undefined, "a.docx", { workspace: "ws1_origin" }, signal)).rejects.toThrow("This client");
  });
});

it("uses the authenticated resource connection without fetching a cross-origin URL", async () => {
  const f = fixture(); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const read = vi.fn(async () => ({ status: 200, headers: {}, body: "AAH/" }));
  const file = await downloadWorkspaceFile(f.host, f.resourceUrl, "a.docx", { workspace: "ws1_original" }, f.signal, read);
  expect(read).toHaveBeenCalledWith(path); expect(fetcher).not.toHaveBeenCalled(); expect(f.resourceUrl).not.toHaveBeenCalled();
  expect([...new Uint8Array(await file.blob.arrayBuffer())]).toEqual([0, 1, 255]);
  expect(f.host.releaseFileDownload).toHaveBeenCalledWith(path, "ws1_original");
});
it("refuses a malformed authenticated resource response and releases the capability", async () => {
  const f = fixture();
  await expect(downloadWorkspaceFile(f.host, f.resourceUrl, "a.docx", { workspace: "ws1_original" }, f.signal, async () => ({ status: 200, headers: {}, body: "invalid!" }))).rejects.toThrow("refused or incomplete");
  expect(f.host.releaseFileDownload).toHaveBeenCalledOnce();
});
