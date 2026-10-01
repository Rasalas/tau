import type { Plugin } from "vite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A file's hash as the manifest records it: text with LF endings, so a CRLF checkout (Windows) matches. */
export function browserConnectHash(path: string, content: Buffer): string {
  const bytes = path.endsWith(".wasm") ? content : Buffer.from(content.toString("utf8").replaceAll("\r\n", "\n"), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

/** Browser assets and licenses never enter the Electron or native mobile build. */
export function browserConnectAssets(): Plugin {
  return {
    name: "browser-connect-assets",
    buildStart() {
      const root = new URL("../browser-connect/", import.meta.url);
      const manifest = JSON.parse(readFileSync(new URL("pkg/manifest.json", root), "utf8")) as { hashes: Record<string, string> };
      for (const [path, expected] of Object.entries(manifest.hashes)) {
        if (browserConnectHash(path, readFileSync(new URL(path, root))) !== expected) this.error("Browser Connect assets are stale. Run npm run build:browser-connect.");
      }
      this.emitFile({ type: "asset", fileName: "THIRD-PARTY-BROWSER-CONNECT-LICENSES.txt", source: readFileSync(fileURLToPath(new URL("pkg/THIRD-PARTY-LICENSES.txt", root)), "utf8") });
    },
  };
}
