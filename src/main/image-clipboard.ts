const MAX_IMAGE_DATA_URL_LENGTH = 16 * 1024 * 1024;
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/u;

/**
 * Image data arrives from the isolated renderer, so keep the native-image
 * boundary deliberately narrow. This also prevents arbitrary data URLs from
 * being handed to Electron's clipboard implementation.
 */
export function validateImageDataUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_IMAGE_DATA_URL_LENGTH) {
    throw new Error("Invalid image data.");
  }
  const match = IMAGE_DATA_URL.exec(value);
  if (!match || match[2].length % 4 !== 0 || Buffer.from(match[2], "base64").length === 0) {
    throw new Error("Invalid image data.");
  }
  return value;
}
