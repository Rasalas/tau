import { describe, expect, it } from "vitest";
import { canonicalFingerprint, pairingUrl, parsePairingPayload } from "./connections.js";
import { decodeHostClientFrame, decodeHostServerFrame } from "./host-transport.js";
import { formatVerification, pairingCommitment, pairingVerificationCode, randomPairingNonce } from "./pairing.js";

const fingerprint = "AB:".repeat(31) + "AB";

describe("a pairing link", () => {
  it("carries the code, the fingerprint, the host and every other address with its kind", () => {
    const url = pairingUrl({ url: "https://192.168.1.20:7788/", kind: "lan" }, {
      code: "c0de_-x",
      fingerprint: fingerprint.toLowerCase(),
      hostId: "f".repeat(32),
      hostName: "Studio Mac",
      endpoints: [{ url: "https://192.168.1.20:7788/", kind: "lan" }, { url: "https://100.101.102.103:7788/", kind: "tailscale" }],
    });
    expect(url).toBe(`https://192.168.1.20:7788/#pair=c0de_-x&k=lan&fp=${"AB".repeat(32)}&host=${"f".repeat(32)}&name=Studio+Mac&e=tailscale:https://100.101.102.103:7788/`);
    expect(parsePairingPayload(url)).toEqual({
      code: "c0de_-x",
      fingerprint,
      hostId: "f".repeat(32),
      hostName: "Studio Mac",
      endpoints: [{ url: "https://192.168.1.20:7788/", kind: "lan" }, { url: "https://100.101.102.103:7788/", kind: "tailscale" }],
    });
  });

  it("carries the key pin and marks the addresses a CA vouches for, its own too", () => {
    const publicKey = "CD:".repeat(31) + "CD";
    const serve = { url: "https://box.tail0000.ts.net/", kind: "magicdns" as const, trustedCertificate: true };
    const lan = { url: "https://192.168.1.20:7788/", kind: "lan" as const };
    const url = pairingUrl(serve, { code: "c", fingerprint, publicKey, endpoints: [serve, lan] });
    expect(url).toContain(`&pk=${"CD".repeat(32)}`);
    expect(url).not.toContain("fp=");
    expect(url).toContain("&ca=https://box.tail0000.ts.net/");
    expect(parsePairingPayload(url)).toEqual({ code: "c", publicKey, endpoints: [serve, lan] });
    const fromLan = parsePairingPayload(pairingUrl(lan, { code: "c", publicKey, endpoints: [serve, lan] }));
    expect(fromLan?.endpoints).toEqual([lan, serve]);
  });

  it("reads as the apps released before it read links", () => {
    const url = pairingUrl({ url: "https://192.168.1.20:7788/", kind: "lan" }, {
      code: "c0de", fingerprint, publicKey: "CD:".repeat(31) + "CD", hostName: "Alex's Mac & more",
      endpoints: [{ url: "https://[fd7a:115c:a1e0::1]:7788/", kind: "tailscale" }, { url: "https://box.tail0000.ts.net/", kind: "magicdns", trustedCertificate: true }],
    });
    // Released apps split the fragment with URLSearchParams, want `pk` as 64 hex and each `e` as `<kind>:<url>`.
    const fields = new URLSearchParams(url.slice(url.indexOf("#") + 1));
    expect(fields.get("pk")).toBe("CD".repeat(32));
    expect(fields.get("name")).toBe("Alex's Mac & more");
    expect(fields.getAll("e").map((entry) => /^([a-z0-9-]+):(https?:\/\/.*)$/u.exec(entry)?.slice(1))).toEqual([
      ["tailscale", "https://[fd7a:115c:a1e0::1]:7788/"], ["magicdns", "https://box.tail0000.ts.net/"],
    ]);
    expect(fields.getAll("ca")).toEqual(["https://box.tail0000.ts.net/"]);
    // Brackets are not allowed unescaped in a fragment (RFC 3986); a strict URL parser in a camera app would stop there.
    expect(url.slice(url.indexOf("#"))).not.toMatch(/[[\]\s]/u);
  });

  it("reads the escaped links of before, and a key as base64url", () => {
    const before = `https://192.168.1.20:7788/#pair=c&k=lan&fp=${"AB".repeat(32)}&pk=${"CD".repeat(32)}&e=mdns%3Ahttps%3A%2F%2Fstudio.local%3A7788%2F`;
    expect(parsePairingPayload(before)).toEqual({
      code: "c", fingerprint, publicKey: "CD:".repeat(31) + "CD",
      endpoints: [{ url: "https://192.168.1.20:7788/", kind: "lan" }, { url: "https://studio.local:7788/", kind: "mdns" }],
    });
    const base64url = btoa(String.fromCharCode(...new Array<number>(32).fill(0xcd))).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
    expect(parsePairingPayload(`https://h/#pair=c&pk=${base64url}`)?.publicKey).toBe("CD:".repeat(31) + "CD");
  });

  it("never lets a CA stand in for the pin on an address or a .local name", () => {
    const text = "https://192.168.1.20:7788/#pair=c&ca=https%3A%2F%2F192.168.1.20%3A7788%2F&e=https://studio.local:7788/&ca=https://studio.local:7788/&e=https://[fd00::1]:7788/&ca=https://[fd00::1]:7788/";
    expect(parsePairingPayload(text)?.endpoints.some((endpoint) => endpoint.trustedCertificate)).toBe(false);
  });

  it("reads the plain links of before, a bare fragment, and nothing without a code", () => {
    expect(parsePairingPayload("http://127.0.0.1:1/#pair=abc")).toEqual({ code: "abc", endpoints: [{ url: "http://127.0.0.1:1/" }] });
    expect(parsePairingPayload("pair=abc&e=javascript:alert(1)&e=lan:javascript:x&e=bogus:https://h/")).toEqual({ code: "abc", endpoints: [{ url: "https://h/" }] });
    expect(parsePairingPayload("https://host/#fp=AB")).toBeUndefined();
  });

  it("drops a fingerprint that is not 32 bytes of hex", () => {
    expect(canonicalFingerprint("sha256:" + "ab".repeat(32))).toBe(fingerprint);
    expect(canonicalFingerprint("AB:CD")).toBeUndefined();
    expect(parsePairingPayload("https://h/#pair=a&fp=zz")?.fingerprint).toBeUndefined();
  });
});

describe("the digits both screens show", () => {
  it("are six, stable for the same inputs and different for another certificate or nonce", async () => {
    const deviceNonce = randomPairingNonce();
    const hostNonce = randomPairingNonce();
    const code = await pairingVerificationCode({ fingerprint, deviceNonce, hostNonce });
    expect(code).toMatch(/^\d{6}$/u);
    expect(await pairingVerificationCode({ fingerprint: fingerprint.replace(/:/gu, "").toLowerCase(), deviceNonce, hostNonce })).toBe(code);
    const others = await Promise.all([
      pairingVerificationCode({ fingerprint: "CD:".repeat(31) + "CD", deviceNonce, hostNonce }),
      pairingVerificationCode({ fingerprint, deviceNonce: randomPairingNonce(), hostNonce }),
      pairingVerificationCode({ fingerprint, deviceNonce, hostNonce: randomPairingNonce() }),
    ]);
    // Six digits collide one time in a million; three at once never do here.
    expect(others.filter((other) => other === code).length).toBeLessThan(3);
    expect(formatVerification("482913")).toBe("482 913");
  });

  it("bound to the key differ from the certificate-bound ones, and hold across a renewal", async () => {
    const deviceNonce = randomPairingNonce();
    const hostNonce = randomPairingNonce();
    const key = await pairingVerificationCode({ publicKey: fingerprint, deviceNonce, hostNonce });
    expect(key).toMatch(/^\d{6}$/u);
    // Same input, other binding: another domain, so one never passes for the other.
    expect(key).not.toBe(await pairingVerificationCode({ fingerprint, deviceNonce, hostNonce }));
    expect(await pairingVerificationCode({ publicKey: fingerprint, fingerprint: "CD:".repeat(31) + "CD", deviceNonce, hostNonce })).toBe(key);
  });

  it("commit to a nonce with its SHA-256", async () => {
    expect(await pairingCommitment("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(randomPairingNonce()).toMatch(/^[\w-]{43}$/u);
  });
});

describe("pairing frames", () => {
  it("decode what a device and a host send, and nothing malformed", () => {
    expect(decodeHostClientFrame({ type: "pair", id: "p", pair: { code: "abc", name: "Phone", commitment: "a".repeat(64) } }))
      .toEqual({ type: "pair", id: "p", pair: { code: "abc", name: "Phone", commitment: "a".repeat(64) } });
    expect(decodeHostClientFrame({ type: "pair", id: "p", pair: { commitment: "short" } })).toBeUndefined();
    expect(decodeHostClientFrame({ type: "pair", id: "p", pair: { code: "x".repeat(300) } })).toBeUndefined();
    expect(decodeHostClientFrame({ type: "pair-reveal", id: "p", nonce: "n".repeat(43) })).toEqual({ type: "pair-reveal", id: "p", nonce: "n".repeat(43) });
    expect(decodeHostClientFrame({ type: "pair-reveal", id: "p", nonce: "short" })).toBeUndefined();

    expect(decodeHostServerFrame({ type: "pair-reply", id: "p", reply: { state: "waiting", requestId: "r", verification: "012345", expiresAt: "t" } }))
      .toMatchObject({ reply: { state: "waiting", verification: "012345" } });
    expect(decodeHostServerFrame({ type: "pair-reply", id: "p", reply: { state: "approved", token: "t", clientId: "c", access: "admin" } })).toBeUndefined();
    expect(decodeHostServerFrame({ type: "pair-reply", id: "p", reply: { state: "refused", reason: "busy" } })).toMatchObject({ reply: { state: "refused", reason: "busy" } });
    expect(decodeHostServerFrame({ type: "pair-reply", id: "p", reply: { state: "whatever" } })).toBeUndefined();
  });
});
