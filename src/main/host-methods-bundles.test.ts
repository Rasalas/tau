import { describe, expect, it } from "vitest";
import type { DesktopExtensionBundle } from "../shared/contracts.js";
import { decodeBundleHashes } from "./ipc-input.js";
import { withBundleDigests } from "./host-methods.js";

const bundle = (id: string, code: string): DesktopExtensionBundle => ({ id, path: `/${id}`, scope: "bundled", code, styles: `.${id}{}`, permissions: [] });

describe("bundles a client already holds", () => {
  it("names every bundle by a digest and leaves out the code and stylesheet of those the client holds", () => {
    const first = withBundleDigests({ bundles: [bundle("a.kit", "A"), bundle("b.kit", "B")], errors: [], skipped: [] }, new Set());
    const [a, b] = first.bundles;
    expect(a?.hash).toMatch(/^[0-9a-f]{32}$/u);
    expect(a?.code).toBe("A");
    const next = withBundleDigests({ bundles: [bundle("a.kit", "A"), bundle("b.kit", "B, changed")], errors: [], skipped: [] }, new Set([a!.hash!, b!.hash!]));
    expect(next.bundles[0]).toMatchObject({ id: "a.kit", code: "", cached: true, hash: a!.hash });
    expect(next.bundles[0]).not.toHaveProperty("styles");
    expect(next.bundles[1]).toMatchObject({ id: "b.kit", code: "B, changed" });
    expect(next.bundles[1]?.hash).not.toBe(b!.hash);
  });

  it("takes only digests from a client", () => {
    expect(decodeBundleHashes("desktop-extensions", "held", undefined)).toBeUndefined();
    expect([...decodeBundleHashes("desktop-extensions", "held", ["0".repeat(32)])!]).toEqual(["0".repeat(32)]);
    expect(() => decodeBundleHashes("desktop-extensions", "held", ["../etc"])).toThrow(/bundle digests/u);
    expect(() => decodeBundleHashes("desktop-extensions", "held", "x")).toThrow(/bundle digests/u);
  });
});
