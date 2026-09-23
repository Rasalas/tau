import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBinaryCookies, encryptChromiumValue, writeChromiumStore, writeFirefoxStore } from "./cookie-fixtures.js";
import { chromiumKey, cookieToWrite, decryptChromium, parseBinaryCookies, readStore, siteOf, sitesOf, withStoreSnapshot } from "./cookie-read.js";
import { parseFirefoxProfiles } from "./cookie-sources.js";

const folders: string[] = [];
async function scratch(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "tau-cookie-read-test-"));
  folders.push(folder);
  return folder;
}
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

const IN_A_YEAR = Math.floor(Date.now() / 1000) + 365 * 86_400;

describe("sites", () => {
  it("groups hosts under their site, keeping addresses and localhost whole", () => {
    expect(siteOf(".accounts.example.com")).toBe("example.com");
    expect(siteOf("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(siteOf("tau.github.io")).toBe("tau.github.io");
    expect(siteOf("localhost")).toBe("localhost");
    expect(siteOf("127.0.0.1")).toBe("127.0.0.1");
    expect(siteOf("[::1]")).toBe("[::1]");
  });

  it("counts cookies per site, alphabetically", () => {
    const cookie = (host: string) => ({ host, name: "n", path: "/", secure: false, httpOnly: false, sameSite: "lax" as const });
    expect(sitesOf([cookie("b.example.com"), cookie(".example.com"), cookie("github.com")])).toEqual([
      { site: "example.com", cookies: 2 },
      { site: "github.com", cookies: 1 },
    ]);
  });
});

describe("Chromium stores", () => {
  const secret = "test-secret";

  it("reads rows with values still encrypted, and leaves partitioned cookies out", async () => {
    const store = join(await scratch(), "Cookies");
    writeChromiumStore(store, [
      { host: ".example.com", name: "sid", value: "s3cret", secure: true, httpOnly: true, sameSite: 1, expires: IN_A_YEAR },
      { host: "localhost", name: "plain", value: "visible", plain: true },
      { host: "embed.example.org", name: "chips", value: "x", partitionKey: "https://top.example" },
    ], { secret });
    const read = await readStore("chromium", store);
    expect(read.schema).toBe(24);
    expect(read.unreadable).toEqual(["embed.example.org"]);
    expect(read.cookies).toHaveLength(2);
    const [sid, plain] = read.cookies;
    expect(sid).toMatchObject({ host: ".example.com", name: "sid", secure: true, httpOnly: true, sameSite: "lax", expires: IN_A_YEAR });
    expect(sid?.value).toBeUndefined();
    expect(Buffer.from(sid!.encrypted!).subarray(0, 3).toString()).toBe("v10");
    expect(plain).toMatchObject({ value: "visible" });
    expect(plain?.expires).toBeUndefined();
  });

  it("decrypts with the macOS key and checks the host binding", () => {
    const key = chromiumKey(secret, "darwin");
    const blob = encryptChromiumValue("s3cret", ".example.com", secret);
    expect(decryptChromium(blob, ".example.com", { v10: key }, 24)).toBe("s3cret");
    // Bound to another host: refused, not handed out.
    expect(decryptChromium(blob, ".evil.com", { v10: key }, 24)).toBeUndefined();
    expect(decryptChromium(blob, ".example.com", { v10: chromiumKey("wrong", "darwin") }, 24)).toBeUndefined();
    expect(decryptChromium(blob, ".example.com", {}, 24)).toBeUndefined();
    const old = encryptChromiumValue("legacy", "example.com", secret, { schema: 20 });
    expect(decryptChromium(old, "example.com", { v10: key }, 20)).toBe("legacy");
  });

  it("derives the Linux key with one round", () => {
    const blob = encryptChromiumValue("penguin", "example.com", "peanuts", { platform: "linux" });
    expect(decryptChromium(blob, "example.com", { v10: chromiumKey("peanuts", "linux") }, 24)).toBe("penguin");
  });

  it("reads a copy and leaves nothing behind in the temporary folder", async () => {
    const store = join(await scratch(), "Cookies");
    writeChromiumStore(store, [{ host: "example.com", name: "a", value: "b" }], { secret });
    let copy = "";
    await withStoreSnapshot(store, async (path) => { copy = path; });
    expect(copy).not.toBe(store);
    await expect(stat(copy)).rejects.toThrow();
    await expect(stat(store)).resolves.toBeTruthy();
  });

  it("calls a file that is not a cookie store a read failure", async () => {
    const store = join(await scratch(), "Cookies");
    await writeFile(store, "not sqlite at all, just text that is long enough to be a header");
    await expect(readStore("chromium", store)).rejects.toThrow(/^\[(read-failed|busy)\]/u);
    await expect(readStore("chromium", join(await scratch(), "missing"))).rejects.toThrow(/^\[read-failed\]/u);
  });
});

describe("Firefox stores", () => {
  it("reads the default container only, with milliseconds from schema 16", async () => {
    const folder = await scratch();
    writeFirefoxStore(join(folder, "new.sqlite"), [
      { host: ".mozilla.org", name: "a", value: "1", expires: IN_A_YEAR, sameSite: 2, secure: true },
      { host: "work.example", name: "b", value: "2", originAttributes: "^userContextId=2" },
    ]);
    writeFirefoxStore(join(folder, "old.sqlite"), [{ host: "old.example", name: "c", value: "3", expires: IN_A_YEAR, sameSite: 256 }], { version: 12 });
    const fresh = await readStore("firefox", join(folder, "new.sqlite"));
    expect(fresh.cookies).toEqual([{ host: ".mozilla.org", name: "a", value: "1", path: "/", secure: true, httpOnly: false, expires: IN_A_YEAR, sameSite: "strict" }]);
    const old = await readStore("firefox", join(folder, "old.sqlite"));
    expect(old.cookies[0]).toMatchObject({ expires: IN_A_YEAR, sameSite: "unspecified" });
  });

  it("keeps a relative profile inside the Firefox folder", () => {
    const profiles = parseFirefoxProfiles([
      "[Install1]", "Default=Profiles/a", "",
      "[Profile0]", "Name=main", "IsRelative=1", "Path=Profiles/a", "",
      "[Profile1]", "Name=escape", "IsRelative=1", "Path=../../etc", "",
      "[Profile2]", "Name=elsewhere", "IsRelative=0", "Path=/Volumes/Data/ff", "",
    ].join("\n"), "/home/me/ff");
    expect(profiles).toEqual([
      { id: "Profiles/a", name: "main", path: "/home/me/ff/Profiles/a" },
      { id: "/Volumes/Data/ff", name: "elsewhere", path: "/Volumes/Data/ff" },
    ]);
  });
});

describe("Safari's binary cookies", () => {
  it("parses records with flags and Apple-epoch expiry", () => {
    const parsed = parseBinaryCookies(buildBinaryCookies([
      { host: ".apple.com", name: "s", value: "v", secure: true, httpOnly: true, expires: IN_A_YEAR },
      { host: "localhost", name: "t", value: "w", path: "/app" },
    ]));
    expect(parsed).toEqual([
      { host: ".apple.com", name: "s", value: "v", path: "/", secure: true, httpOnly: true, expires: IN_A_YEAR, sameSite: "lax" },
      { host: "localhost", name: "t", value: "w", path: "/app", secure: false, httpOnly: false, sameSite: "lax" },
    ]);
  });

  it("refuses a file whose layout does not hold together", () => {
    const good = buildBinaryCookies([{ host: "a.com", name: "n", value: "v" }]);
    expect(() => parseBinaryCookies(Buffer.from("nope"))).toThrow(/^\[read-failed\]/u);
    const lying = Buffer.from(good);
    lying.writeUInt32BE(good.length, 8);
    expect(() => parseBinaryCookies(lying)).toThrow(/^\[read-failed\]/u);
    const badOffset = Buffer.from(good);
    badOffset.writeUInt32LE(1, 12 + 8);
    expect(() => parseBinaryCookies(badOffset)).toThrow(/^\[read-failed\]/u);
  });
});

describe("writing", () => {
  it("gives a domain only to domain cookies, and brackets an IPv6 host", () => {
    const base = { name: "n", path: "/", secure: true, httpOnly: false, sameSite: "lax" as const };
    expect(cookieToWrite({ ...base, host: ".example.com", expires: 5 }, "v")).toEqual({ url: "https://example.com/", name: "n", value: "v", domain: ".example.com", path: "/", secure: true, httpOnly: false, expirationDate: 5, sameSite: "lax" });
    expect(cookieToWrite({ ...base, host: "example.com" }, "v")).not.toHaveProperty("domain");
    expect(cookieToWrite({ ...base, host: "::1", secure: false }, "v").url).toBe("http://[::1]/");
  });
});
