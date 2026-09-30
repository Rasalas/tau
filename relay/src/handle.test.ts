import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openHandle, parseKeyring, sealHandle } from "./handle.js";

const key = () => randomBytes(32).toString("base64");
const IOS = { platform: "ios", token: "ab".repeat(32) } as const;
const ANDROID = { platform: "android", token: "fcm:APA91b-registration-token" } as const;

describe("relay handles", () => {
  it("seal a registration that only the relay's keys open again", () => {
    const keyring = parseKeyring(`1:${key()}`);
    const handle = sealHandle(keyring, IOS);
    expect(handle).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(handle).not.toContain(IOS.token);
    expect(openHandle(keyring, handle)).toEqual(IOS);
    expect(openHandle(parseKeyring(`1:${key()}`), handle)).toBeUndefined();
    // A random nonce: the same token never gives the same handle twice.
    expect(sealHandle(keyring, IOS)).not.toBe(handle);
  });

  it("rotate: the first key seals, every listed key still opens", () => {
    const old = key();
    const before = parseKeyring(`1:${old}`);
    const handle = sealHandle(before, ANDROID);
    const after = parseKeyring(`2:${key()}, 1:${old}`);
    expect(after.current).toBe(2);
    expect(openHandle(after, handle)).toEqual(ANDROID);
    const fresh = sealHandle(after, ANDROID);
    expect(Buffer.from(fresh, "base64url")[1]).toBe(2);
    expect(openHandle(before, fresh)).toBeUndefined();
    expect(openHandle(parseKeyring(`2:${key()}`), handle)).toBeUndefined();
  });

  it("refuse a handle whose version, key id or ciphertext was changed", () => {
    const keyA = key();
    const keyring = parseKeyring(`3:${keyA}, 4:${keyA}`);
    const bytes = Buffer.from(sealHandle(keyring, IOS), "base64url");
    const changed = (index: number, value: number) => { const copy = Buffer.from(bytes); copy[index] = value; return copy.toString("base64url"); };
    expect(openHandle(keyring, changed(0, 2))).toBeUndefined();
    // Same key under another id: the id is bound as associated data.
    expect(openHandle(keyring, changed(1, 4))).toBeUndefined();
    expect(openHandle(keyring, changed(20, bytes[20]! ^ 1))).toBeUndefined();
    expect(openHandle(keyring, "short")).toBeUndefined();
    expect(openHandle(keyring, 42)).toBeUndefined();
  });

  it("read the secret strictly, and never repeat a key in an error", () => {
    const secret = key();
    expect(() => parseKeyring("")).toThrow(/no key/u);
    expect(() => parseKeyring(`0:${secret}`)).toThrow(/entry 1/u);
    expect(() => parseKeyring(`1:${randomBytes(16).toString("base64")}`)).toThrow(/32 bytes/u);
    expect(() => parseKeyring(`1:${secret},1:${key()}`)).toThrow(/twice/u);
    try { parseKeyring(`1:${secret}x`); } catch (error) { expect(String(error)).not.toContain(secret); }
  });
});
