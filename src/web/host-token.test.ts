import { describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "../workbench/client-storage";
import {
  WEB_TOKEN_KEY,
  hostSocketUrl,
  redeemPairingCode,
  resolveHostToken,
  takePairingCode,
  type PairingPage,
} from "./host-token";

function page(hash: string): PairingPage & { replaced: string[] } {
  const replaced: string[] = [];
  return {
    replaced,
    location: { hash, pathname: "/", search: "", protocol: "http:", host: "127.0.0.1:7788" },
    history: { replaceState: (_state, _title, url) => { replaced.push(url); } },
  };
}

const ok = (token: string) => async () => new Response(JSON.stringify({ token }), { status: 200 });
const refused = async () => new Response(JSON.stringify({ error: "unknown pairing code" }), { status: 403 });

describe("how a browser learns the host token", () => {
  it("takes the pairing code out of the address bar as it reads it", () => {
    const current = page("#pair=abc123");
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

  it("redeems a code, and treats a refusal as no token rather than an error", async () => {
    expect(await redeemPairingCode("abc", ok("t0ken") as unknown as typeof fetch)).toBe("t0ken");
    expect(await redeemPairingCode("abc", refused as unknown as typeof fetch)).toBeUndefined();
    const offline = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await redeemPairingCode("abc", offline as unknown as typeof fetch)).toBeUndefined();
  });

  it("keeps a redeemed token for the next visit", async () => {
    const storage = createMemoryStorage();
    expect(await resolveHostToken(storage, "abc", ok("t0ken") as unknown as typeof fetch)).toBe("t0ken");
    expect(storage.get(WEB_TOKEN_KEY)).toBe("t0ken");
    // A second visit brings no code and needs none.
    expect(await resolveHostToken(storage, undefined)).toBe("t0ken");
  });

  it("falls back to the stored token when the link was already used", async () => {
    const storage = createMemoryStorage();
    storage.set(WEB_TOKEN_KEY, "older");
    expect(await resolveHostToken(storage, "spent", refused as unknown as typeof fetch)).toBe("older");
  });

  it("has no token at all for a first visit without a link", async () => {
    expect(await resolveHostToken(createMemoryStorage(), undefined)).toBeUndefined();
  });
});
