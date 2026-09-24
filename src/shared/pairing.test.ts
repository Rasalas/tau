import { describe, expect, it } from "vitest";
import { canonicalFingerprint, pairingUrl, parsePairingPayload } from "./connections.js";
import { decodeHostClientFrame, decodeHostServerFrame } from "./host-transport.js";
import { formatVerification, pairingCommitment, pairingVerificationCode, randomPairingNonce } from "./pairing.js";

const fingerprint = "AB:".repeat(31) + "AB";

describe("a pairing link", () => {
  it("carries the code, the fingerprint, the host and every other address in its fragment", () => {
    const url = pairingUrl("https://192.168.1.20:7788/", {
      code: "c0de_-x",
      fingerprint: fingerprint.toLowerCase(),
      hostId: "f".repeat(32),
      hostName: "Studio Mac",
      endpoints: ["https://192.168.1.20:7788/", "https://100.101.102.103:7788/"],
    });
    expect(url).toBe(`https://192.168.1.20:7788/#pair=c0de_-x&fp=${"AB".repeat(32)}&host=${"f".repeat(32)}&name=Studio+Mac&e=https%3A%2F%2F100.101.102.103%3A7788%2F`);
    expect(parsePairingPayload(url)).toEqual({
      code: "c0de_-x",
      fingerprint,
      hostId: "f".repeat(32),
      hostName: "Studio Mac",
      endpoints: ["https://192.168.1.20:7788/", "https://100.101.102.103:7788/"],
    });
  });

  it("reads the plain links of before, a bare fragment, and nothing without a code", () => {
    expect(parsePairingPayload("http://127.0.0.1:1/#pair=abc")).toEqual({ code: "abc", endpoints: ["http://127.0.0.1:1/"] });
    expect(parsePairingPayload("pair=abc&e=javascript:alert(1)")).toEqual({ code: "abc", endpoints: [] });
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
