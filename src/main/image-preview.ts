import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import type { UiImagePreview } from "../shared/contracts.js";

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const IMAGE_MIME = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

export async function readBoundedImagePreview(inputPath: string): Promise<UiImagePreview | undefined> {
  if (!isAbsolute(inputPath)) return undefined;
  const canonical = await realpath(inputPath).catch(() => undefined);
  if (!canonical) return undefined;
  const mimeType = IMAGE_MIME.get(extname(canonical).toLocaleLowerCase());
  if (!mimeType) return undefined;
  const info = await stat(canonical).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_IMAGE_BYTES) return undefined;
  const data = await readFile(canonical);
  return { name: basename(canonical), dataUrl: `data:${mimeType};base64,${data.toString("base64")}` };
}
