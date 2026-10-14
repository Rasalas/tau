// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readImage } from "./ComposerAttachments";

function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("composer image bytes", () => {
  it.each([
    { mimeType: "image/png", width: 4000, height: 1000, targetWidth: 2000, targetHeight: 500 },
    { mimeType: "image/jpeg", width: 1500, height: 3000, targetWidth: 1000, targetHeight: 2000 },
    { mimeType: "image/png", width: 1, height: 4000, targetWidth: 1, targetHeight: 2000 },
  ])("fits $mimeType $width × $height before storing its bytes", async ({ mimeType, width, height, targetWidth, targetHeight }) => {
    const bitmap = { width, height, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    const encoded = png(targetWidth, targetHeight);
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback, type) {
      expect(this.width).toBe(targetWidth);
      expect(this.height).toBe(targetHeight);
      callback(new Blob([encoded], { type }));
    });
    const attachment = await readImage(new File([png(width, height)], "shot", { type: mimeType }));
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, targetWidth, targetHeight);
    expect(encode).toHaveBeenCalledWith(expect.any(Function), mimeType);
    expect(attachment.data).toBe(btoa(String.fromCharCode(...encoded)));
    expect(attachment.previewUrl).toBe(`data:${mimeType};base64,${attachment.data}`);
    expect(attachment.size).toBe(encoded.length);
    expect(attachment.mimeType).toBe(mimeType);
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it.each(["image/png", "image/jpeg", "image/gif", "image/webp"])("leaves fitting %s bytes unchanged", async (mimeType) => {
    const bitmap = { width: 2000, height: 1000, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob");
    const bytes = png(2000, 1000);
    const attachment = await readImage(new File([bytes], "small", { type: mimeType }));
    expect(attachment.data).toBe(btoa(String.fromCharCode(...bytes)));
    expect(attachment.size).toBe(bytes.length);
    expect(attachment.mimeType).toBe(mimeType);
    expect(encode).not.toHaveBeenCalled();
  });

  it.each(["image/gif", "image/webp"])("leaves large %s images unchanged", async (mimeType) => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    const bytes = png(4000, 3000);
    const attachment = await readImage(new File([bytes], "animation", { type: mimeType }));
    expect(attachment.data).toBe(btoa(String.fromCharCode(...bytes)));
    expect(decode).not.toHaveBeenCalled();
  });

  it.each(["context", "encoding"])("rejects a large image when %s fails instead of retaining oversized bytes", async (failure) => {
    const bitmap = { width: 4000, height: 1000, close: vi.fn() };
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(failure === "context" ? null : { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(null));
    await expect(readImage(new File([png(4000, 1000)], "shot.png", { type: "image/png" }))).rejects.toThrow("shot.png could not be resized.");
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
