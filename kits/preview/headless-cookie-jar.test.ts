import { describe, expect, it, vi } from "vitest";
import { headlessCookieJar } from "./headless-cookie-jar.js";
import type { CookieToWrite } from "./cookie-read.js";

const cookie: CookieToWrite = { url: "https://example.test/account", name: "fixture", value: "synthetic", path: "/account", secure: true, httpOnly: true, sameSite: "lax" };
const stored = { name: cookie.name, value: cookie.value, domain: "example.test", path: cookie.path, secure: true, httpOnly: true, sameSite: "Lax", session: true, expires: -1 };
function setup(cookies: object[] = [stored]) {
  const calls: Array<{ method: string; params?: object }> = [];
  const close = vi.fn(async () => undefined);
  const jar = headlessCookieJar(async <T>(method: string, params?: object) => { calls.push({ method, params }); return (method === "Storage.getCookies" ? { cookies } : {}) as T; }, close);
  return { jar, calls, close };
}
describe("the owned headless cookie jar", () => {
  it.each([["unspecified", undefined], ["no_restriction", "None"], ["lax", "Lax"], ["strict", "Strict"]] as const)("maps %s without changing session semantics", async (sameSite, expected) => {
    const { jar, calls, close } = setup([{ ...stored, sameSite: expected }]);
    await jar.set({ ...cookie, sameSite });
    const mapped = (calls[0]!.params as { cookies: object[] }).cookies[0]!;
    expect(mapped).toEqual({ url: cookie.url, name: cookie.name, value: cookie.value, path: cookie.path, secure: true, httpOnly: true, ...(expected ? { sameSite: expected } : {}) });
    expect(mapped).not.toHaveProperty("expires");
    expect(mapped).not.toHaveProperty("domain");
    expect(calls.map((call) => call.method)).toEqual(["Storage.setCookies", "Storage.getCookies"]);
    expect(close).not.toHaveBeenCalled();
    await jar.flushStore();
    expect(close).toHaveBeenCalledOnce();
  });
  it("accepts a clamped expiry and explicit domain without broadening host-only cookies", async () => {
    const { jar, calls } = setup([{ ...stored, domain: ".example.test", session: false, expires: 2_000 }]);
    await jar.set({ ...cookie, domain: ".example.test", expirationDate: 5_000 });
    expect(calls[0]!.params).toMatchObject({ cookies: [{ domain: ".example.test", expires: 5_000 }] });
    await expect(jar.set({ ...cookie, expirationDate: 5_000 })).rejects.toThrow("refused");
  });
  it("allows Chromium to narrow an explicit IP domain to host-only", async () => {
    const { jar } = setup([{ ...stored, domain: "127.0.0.1" }]);
    await jar.set({ ...cookie, url: "https://127.0.0.1/account", domain: ".127.0.0.1" });
  });
  it.each([
    [], [{ ...stored, value: "other" }], [{ ...stored, domain: ".example.test" }],
    [{ ...stored, path: "/" }], [{ ...stored, secure: false }], [{ ...stored, httpOnly: false }],
    [{ ...stored, sameSite: "None" }], [{ ...stored, session: false, expires: 100 }],
    [{ ...stored, partitionKey: { topLevelSite: "https://other.test" } }],
  ])("does not count an acknowledged but refused cookie", async (...cookies) => {
    await expect(setup(cookies.flat()).jar.set(cookie)).rejects.toThrow("refused");
  });
  it("propagates persistence failures", async () => {
    const jar = headlessCookieJar(async <T>() => ({}) as T, async () => { throw new Error("normal shutdown failed"); });
    await expect(jar.flushStore()).rejects.toThrow("normal shutdown failed");
  });
});
