import { nativeImage, type NativeImage } from "electron";
import type { WindowExtension, WindowExtensionContext } from "tau/host-extension";
import type { EncodedFrame } from "./protocol.js";

const QUALITY = 72;
const LUMA_WIDTH = 160;

function scaled(image: NativeImage, width: number): NativeImage {
  const size = image.getSize();
  if (size.width <= width) return image;
  return image.resize({ width, height: Math.max(1, Math.round(size.height * (width / size.width))), quality: "good" });
}

/** Brightness per pixel of a BGRA bitmap, the eye's weights in integers. */
export function lumaOf(bitmap: Uint8Array, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels);
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    out[index] = ((bitmap[offset + 2] ?? 0) * 77 + (bitmap[offset + 1] ?? 0) * 150 + (bitmap[offset] ?? 0) * 29) >> 8;
  }
  return out;
}

/**
 * Evidence Kit's window half. The host runs as plain Node and has no image
 * codec, so the window's process shrinks each picture to the frame, the
 * thumbnail and the grey copy the host compares.
 */
export default function activate(_context: WindowExtensionContext): WindowExtension {
  return {
    handle(command: string, input?: unknown): unknown {
      if (command !== "encode") throw new Error(`Evidence's window half has no command "${command}".`);
      const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
      const image = nativeImage.createFromBuffer(Buffer.from(String(fields.data ?? ""), "base64"));
      if (image.isEmpty()) throw new Error("The picture could not be read.");
      const frame = scaled(image, Number(fields.width) || 960);
      const thumb = scaled(frame, Number(fields.thumbWidth) || 160);
      const grey = scaled(frame, LUMA_WIDTH);
      const greySize = grey.getSize();
      const size = frame.getSize();
      const answer: EncodedFrame = {
        frame: frame.toJPEG(QUALITY).toString("base64"),
        width: size.width,
        height: size.height,
        thumb: thumb.toJPEG(QUALITY).toString("base64"),
        luma: Buffer.from(lumaOf(grey.toBitmap(), greySize.width * greySize.height)).toString("base64"),
        lumaWidth: greySize.width,
        lumaHeight: greySize.height,
      };
      return answer;
    },
  };
}
