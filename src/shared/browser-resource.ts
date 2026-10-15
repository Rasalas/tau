/** A bounded response carried over the existing authenticated host connection. */
export interface BrowserResourceResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export const BROWSER_RESOURCE_MAX_BYTES = 10 * 1024 * 1024;
