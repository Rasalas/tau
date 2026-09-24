import { describe, expect, it } from "vitest";
import { hostSocketUrl, pairingNotice, takePairingCode, type PairingPage } from "./host-token";

function page(hash: string): PairingPage & { replaced: string[] } {
  const replaced: string[] = [];
  return {
    replaced,
    location: { hash, pathname: "/", search: "", protocol: "http:", host: "127.0.0.1:7788" },
    history: { replaceState: (_state, _title, url) => { replaced.push(url); } },
  };
}

describe("how a browser learns the host token", () => {
  it("takes the pairing code out of the address bar as it reads it", () => {
    const current = page("#pair=abc123");
    expect(takePairingCode(current)).toBe("abc123");
    expect(current.replaced).toEqual(["/"]);
  });

  it("reads the code from a link that also carries the fingerprint and the addresses", () => {
    const current = page(`#pair=abc123&fp=${"AB".repeat(32)}&e=https%3A%2F%2F100.64.0.1%3A7788%2F`);
    expect(takePairingCode(current)).toBe("abc123");
    expect(current.replaced).toEqual(["/"]);
  });

  it("leaves an address without a code alone", () => {
    const current = page("");
    expect(takePairingCode(current)).toBeUndefined();
    expect(current.replaced).toEqual([]);
  });

  it("talks to the host that served the page", () => {
    expect(hostSocketUrl({ protocol: "http:", host: "127.0.0.1:7788" })).toBe("ws://127.0.0.1:7788/");
    expect(hostSocketUrl({ protocol: "https:", host: "tau.example:443" })).toBe("wss://tau.example:443/");
  });

  it("says why pairing did not let it in", () => {
    expect(pairingNotice({ state: "denied" })).toMatch(/declined/u);
    expect(pairingNotice({ state: "expired" })).toMatch(/in time/u);
    expect(pairingNotice({ state: "refused", reason: "unknown-code" })).toMatch(/already used or has expired/u);
    expect(pairingNotice({ state: "refused", reason: "busy" })).toMatch(/not taking a request/u);
    expect(pairingNotice({ state: "failed", message: "offline" })).toBe("offline");
  });
});
