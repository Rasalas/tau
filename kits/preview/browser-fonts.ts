import { execFile } from "node:child_process";

export const NO_FONTS_MESSAGE = "The preview browser found no system fonts, so pages would show no text. Install fontconfig and a font package (on Debian or Ubuntu: apt install fontconfig fonts-liberation), then try again.";

/** Empty output stands for a host with no `fc-match` or no font behind it. */
export function fontMatch(): Promise<string> {
  return new Promise((resolve) => {
    execFile("fc-match", ["--format=%{file}", "sans-serif"], { timeout: 5_000, windowsHide: true }, (error, stdout) => resolve(error ? "" : stdout.trim()));
  });
}

let found = false;

/** Headless Chromium on Linux renders no text without fontconfig and one font. */
export async function requireBrowserFonts(platform: NodeJS.Platform = process.platform, match: () => Promise<string> = fontMatch): Promise<void> {
  if (platform !== "linux" || found) return;
  if (!(await match())) throw new Error(NO_FONTS_MESSAGE);
  found = true;
}
