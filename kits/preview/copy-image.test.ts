import { describe, expect, it, vi } from "vitest";
import { MAX_COPY_IMAGE_BYTES, readImageBytes } from "./copy-image.js";

const answer = (body: Uint8Array, init: ResponseInit = {}) => vi.fn(async () => new Response(Buffer.from(body), init));

describe("readImageBytes", () => {
  it("reads an http image without cookies and refuses a redirect", async () => {
    const fetch = answer(Uint8Array.from([1, 2, 3]));
    expect([...await readImageBytes("https://example.com/a.png", fetch)]).toEqual([1, 2, 3]);
    expect(fetch).toHaveBeenCalledWith("https://example.com/a.png", expect.objectContaining({ credentials: "omit", redirect: "error" }));
  });

  it("decodes a data URL itself, base64 or not", async () => {
    const fetch = answer(new Uint8Array());
    expect([...await readImageBytes("data:image/png;base64,AQID", fetch)]).toEqual([1, 2, 3]);
    expect((await readImageBytes("data:text/plain,hi%21", fetch)).toString()).toBe("hi!");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses other schemes and credentials in the address", async () => {
    const fetch = answer(new Uint8Array());
    for (const url of ["file:///etc/passwd", "ftp://example.com/a.png", "https://user:pw@example.com/a.png", "not a url"]) {
      await expect(readImageBytes(url, fetch)).rejects.toThrow("Unsupported image URL");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops at the size limit, by header or by what arrives", async () => {
    await expect(readImageBytes("https://example.com/a.png", answer(new Uint8Array(4), { headers: { "content-length": String(MAX_COPY_IMAGE_BYTES + 1) } }))).rejects.toThrow(/too large/u);
    const big = vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_COPY_IMAGE_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } })));
    await expect(readImageBytes("https://example.com/a.png", big)).rejects.toThrow(/too large/u);
  });

  it("fails on an error status", async () => {
    await expect(readImageBytes("https://example.com/a.png", answer(new Uint8Array(1), { status: 404 }))).rejects.toThrow(/did not load/u);
  });
});
