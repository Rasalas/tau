/** The most bytes of an image a right-click copies; a larger one is not a picture to hold in the clipboard. */
export const MAX_COPY_IMAGE_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

type Fetch = (url: string, init: { credentials: "omit"; redirect: "error"; signal: AbortSignal }) => Promise<Response>;

/** The bytes behind an image URL a page's frame showed: http(s) over `fetch`, or a data URL. */
export async function readImageBytes(srcURL: string, fetch: Fetch): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(srcURL);
  } catch {
    throw new Error("Unsupported image URL");
  }
  if (!["http:", "https:", "data:"].includes(url.protocol) || url.username || url.password) throw new Error("Unsupported image URL");
  if (url.protocol === "data:") {
    const match = /^data:[^,]*?(;base64)?,(.*)$/su.exec(srcURL);
    if (!match || srcURL.length > MAX_COPY_IMAGE_BYTES * 2) throw new Error("Unsupported image URL");
    const bytes = match[1] ? Buffer.from(match[2]!, "base64") : Buffer.from(decodeURIComponent(match[2]!), "latin1");
    if (bytes.length > MAX_COPY_IMAGE_BYTES) throw new Error("The image is too large to copy");
    return bytes;
  }
  const response = await fetch(url.href, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok || Number(response.headers.get("content-length")) > MAX_COPY_IMAGE_BYTES || !response.body) {
    await response.body?.cancel();
    throw new Error("The image did not load or is too large to copy");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_COPY_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("The image is too large to copy");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}
