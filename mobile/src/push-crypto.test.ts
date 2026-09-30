import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PUSH_RELAY_URL } from "../../kits/push/protocol";
import { sealPush } from "../../kits/push/relay";
import { fromBase64url, newPushKey, openSealedPush, toBase64url } from "./push-crypto";

const CONTENT = { title: "Fix the build", body: "Tests pass — ✓", url: "tau://thread?host=h&thread=t1", kind: "completed" as const, tag: "tag-1" };

describe("sealed pushes on the phone", () => {
  it("open what the host sealed with this phone's key, and nothing sealed with another", async () => {
    const key = newPushKey();
    expect(key.keyId).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(fromBase64url(key.key)).toHaveLength(32);
    const sealed = sealPush(key, CONTENT);
    const keys = new Map([[key.keyId, key.key]]);
    await expect(openSealedPush(sealed, async (id) => keys.get(id))).resolves.toEqual(CONTENT);
    await expect(openSealedPush(sealed, async () => newPushKey().key)).resolves.toBeUndefined();
    await expect(openSealedPush(sealed, async () => undefined)).resolves.toBeUndefined();
  });

  it("refuse a push moved to another key id, of another version, or cut short", async () => {
    const key = newPushKey();
    const other = newPushKey();
    const [, , data] = sealPush(key, CONTENT).split(".");
    // Same key under another id: the id is bound as associated data.
    const keyFor = async () => key.key;
    await expect(openSealedPush(`1.${other.keyId}.${data}`, keyFor)).resolves.toBeUndefined();
    await expect(openSealedPush(`2.${key.keyId}.${data}`, keyFor)).resolves.toBeUndefined();
    await expect(openSealedPush(`1.${key.keyId}.${data!.slice(0, -4)}`, keyFor)).resolves.toBeUndefined();
    await expect(openSealedPush(42, keyFor)).resolves.toBeUndefined();
  });

  it("round-trip base64url", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_value, index) => index);
    expect(fromBase64url(toBase64url(bytes))).toEqual(bytes);
    expect(toBase64url(bytes)).not.toMatch(/[+/=]/u);
  });

  it("let the page reach the relay, and only the relay beyond the app itself", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const connect = /connect-src ([^;"]+)/u.exec(html)![1]!.trim().split(/\s+/u);
    expect(connect).toEqual(["'self'", "capacitor://localhost", "https://localhost", new URL(PUSH_RELAY_URL).origin]);
  });
});
