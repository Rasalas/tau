import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { browserConnectHash } from "./browser-connect";

describe("browserConnectHash", () => {
  it("matches the manifest for every checked-in file, and for a CRLF checkout of the text files", () => {
    const root = new URL("../browser-connect/", import.meta.url);
    const { hashes } = JSON.parse(readFileSync(new URL("pkg/manifest.json", root), "utf8")) as { hashes: Record<string, string> };
    for (const [path, expected] of Object.entries(hashes)) {
      const content = readFileSync(new URL(path, root));
      expect(browserConnectHash(path, content)).toBe(expected);
      if (path.endsWith(".wasm")) continue;
      const crlf = Buffer.from(content.toString("utf8").replaceAll("\n", "\r\n"), "utf8");
      expect(browserConnectHash(path, crlf)).toBe(expected);
    }
  });
});

describe("browser adapter reproducibility", () => {
  it("ships canonical dependency paths instead of the builder's Cargo home", () => {
    const wasm = readFileSync(new URL("../browser-connect/pkg/tau_browser_connect_bg.wasm", import.meta.url)).toString("latin1");
    expect(wasm.includes("/cargo/registry/src/ring-0.17.14/")).toBe(true);
    expect(/\/(?:Users|home|tmp|private|Volumes)\//u.test(wasm)).toBe(false);
  });
});
