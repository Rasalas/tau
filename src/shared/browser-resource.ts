/** A bounded response carried over the existing authenticated host connection. */
export interface BrowserResourceResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export const BROWSER_RESOURCE_MAX_BYTES = 10 * 1024 * 1024;
export const BROWSER_RESOURCE_PATH = /^\/resources\/[0-9a-f]{64}$/u;

/** Join a capability path to the transport's trusted base, never an arbitrary URL. */
export function browserResourceUrl(base: string, path: string): string {
  if (!BROWSER_RESOURCE_PATH.test(path)) throw new Error("Invalid host resource path.");
  return `${base}${path}`;
}
