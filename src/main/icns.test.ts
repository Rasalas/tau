import { describe, expect, it } from "vitest";
import { extractIcnsPng } from "./icns.js";

/** A PNG signature and IHDR with the given width: all the reader looks at. */
function png(width: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12);
  bytes.writeUInt32BE(width, 16);
  return bytes;
}

function icns(...entries: [string, Buffer][]): Buffer {
  const body = Buffer.concat(entries.map(([type, payload]) => {
    const head = Buffer.alloc(8);
    head.write(type);
    head.writeUInt32BE(payload.length + 8, 4);
    return Buffer.concat([head, payload]);
  }));
  const head = Buffer.alloc(8);
  head.write("icns");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

describe("extractIcnsPng", () => {
  it("takes the smallest PNG at least as wide as asked", () => {
    const file = icns(["ic07", png(128)], ["ic08", png(256)], ["ic09", png(512)]);
    expect(extractIcnsPng(file, 96)).toEqual(Uint8Array.from(png(128)));
    expect(extractIcnsPng(file, 200)).toEqual(Uint8Array.from(png(256)));
  });

  it("falls back to the largest PNG when none is wide enough", () => {
    expect(extractIcnsPng(icns(["ic11", png(32)], ["ic12", png(64)]), 96)).toEqual(Uint8Array.from(png(64)));
  });

  it("skips entries that are not PNG and files that are not icns", () => {
    expect(extractIcnsPng(icns(["is32", Buffer.from("rle data, not a png.........")]), 96)).toBeUndefined();
    expect(extractIcnsPng(icns(["ic07", png(128)]).subarray(0, 4), 96)).toBeUndefined();
    expect(extractIcnsPng(Buffer.from("not an icon at all"), 96)).toBeUndefined();
  });

  it("stops at an entry that runs past the end", () => {
    const file = icns(["ic07", png(128)], ["ic08", png(256)]);
    expect(extractIcnsPng(file.subarray(0, file.length - 4), 96)).toEqual(Uint8Array.from(png(128)));
  });

  it("returns a copy that does not keep the whole file alive", () => {
    const file = icns(["ic07", png(128)]);
    expect(extractIcnsPng(file, 96)!.buffer).not.toBe(file.buffer);
  });
});
