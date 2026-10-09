import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { pickReleaseFile, readUpdateRelease, releaseFeedBase, releaseFileUrl, releaseInfoName, safeReleaseName, verifyReleaseSignature } from "./release-feed.js";

const FEED = { owner: "Rasalas", repo: "tau-releases" };
const file = (url: string) => ({ url, sha512: "x" });

describe("release feed", () => {
  describe("nightly release selection", () => {
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    function feeds(nightly: string | undefined, stable: string | undefined, invalid?: "nightly" | "stable") {
      return vi.fn(async (url: string) => {
        const channel = url.includes("/nightly/") ? "nightly" : "stable";
        const version = channel === "nightly" ? nightly : stable;
        if (!version) return new Response("", { status: 404 });
        const text = `version: ${version}\n`;
        return new Response(url.endsWith(".sig") ? channel === invalid ? "bad signature" : sign(null, Buffer.from(text), keys.privateKey).toString("base64") : text);
      });
    }
    const select = (fetch: ReturnType<typeof feeds>, channel: "nightly" | "stable" = "nightly", override?: string) => readUpdateRelease({
      fetch, channel, feed: FEED, name: "latest-linux.yml", keys: [publicKey], ...(override ? { override } : {}),
    });

    it.each([
      ["0.7.40-nightly.20261008.50", "0.7.40", "stable", "0.7.40"],
      ["0.7.41-nightly.20261009.51", "0.7.40", "nightly", "0.7.41-nightly.20261009.51"],
    ] as const)("compares %s and %s by version", async (nightly, stable, channel, version) => {
      expect(await select(feeds(nightly, stable))).toMatchObject({ channel, info: { version, signed: true } });
    });

    it.each(["nightly", "stable"] as const)("uses the other feed when %s is missing or has an invalid signature", async (failed) => {
      const nightly = "0.7.41-nightly.20261009.51";
      for (const missing of [true, false]) {
        const fetch = feeds(missing && failed === "nightly" ? undefined : nightly, missing && failed === "stable" ? undefined : "0.7.40", missing ? undefined : failed);
        expect(await select(fetch)).toMatchObject({ channel: failed === "nightly" ? "stable" : "nightly" });
      }
    });

    it("fails when neither feed can be trusted", async () => {
      await expect(select(feeds(undefined, undefined))).rejects.toThrow(/404/u);
    });

    it("reads only stable on stable, and only the override for a local test feed", async () => {
      const fetch = feeds("0.7.41-nightly.20261009.51", "0.7.40");
      expect(await select(fetch, "stable")).toMatchObject({ channel: "stable" });
      expect(fetch.mock.calls.every(([url]) => !url.includes("/nightly/"))).toBe(true);
      fetch.mockClear();
      await select(fetch, "nightly", "http://127.0.0.1:9/feed/");
      expect(fetch.mock.calls.map(([url]) => url)).toEqual(["http://127.0.0.1:9/feed/latest-linux.yml", "http://127.0.0.1:9/feed/latest-linux.yml.sig"]);
    });
  });

  it("reads stable from the latest release, nightly from its tag, and a file of a stable release from that release's tag", () => {
    expect(releaseFeedBase("stable", FEED)).toBe("https://github.com/Rasalas/tau-releases/releases/latest/download/");
    expect(releaseFeedBase("nightly", FEED)).toBe("https://github.com/Rasalas/tau-releases/releases/download/nightly/");
    expect(releaseFeedBase("stable", undefined)).toBeUndefined();
    expect(releaseFeedBase("stable", FEED, "http://127.0.0.1:9/feed")).toBe("http://127.0.0.1:9/feed/");
    const base = releaseFeedBase("stable", FEED)!;
    expect(releaseFileUrl("Tau_0.7.14_amd64.deb", "0.7.14", "stable", base, FEED)).toBe("https://github.com/Rasalas/tau-releases/releases/download/v0.7.14/Tau_0.7.14_amd64.deb");
    expect(releaseFileUrl("Tau_0.7.15-nightly.20260929.3_amd64.deb", "0.7.15-nightly.20260929.3", "nightly", releaseFeedBase("nightly", FEED)!, FEED))
      .toBe("https://github.com/Rasalas/tau-releases/releases/download/nightly/Tau_0.7.15-nightly.20260929.3_amd64.deb");
  });

  it("names electron-builder's update file per platform", () => {
    expect(releaseInfoName("linux", "x64")).toBe("latest-linux.yml");
    expect(releaseInfoName("linux", "arm64")).toBe("latest-linux-arm64.yml");
    expect(releaseInfoName("darwin", "arm64")).toBe("latest-mac.yml");
    expect(releaseInfoName("win32", "x64")).toBe("latest.yml");
  });

  it("picks the file each install takes, and nothing with a path in its name", () => {
    const files = ["Tau-0.7.14.AppImage", "Tau-0.7.14-arm64.AppImage", "Tau_0.7.14_amd64.deb", "Tau_0.7.14_arm64.deb", "Tau-0.7.14-arm64-mac.zip", "Tau-0.7.14-mac.zip", "Tau-0.7.14.dmg", "Tau-Setup-0.7.14.exe"].map(file);
    expect(pickReleaseFile(files, "deb", "x64")?.url).toBe("Tau_0.7.14_amd64.deb");
    expect(pickReleaseFile(files, "deb", "arm64")?.url).toBe("Tau_0.7.14_arm64.deb");
    expect(pickReleaseFile(files, "appimage", "x64")?.url).toBe("Tau-0.7.14.AppImage");
    expect(pickReleaseFile(files, "appimage", "arm64")?.url).toBe("Tau-0.7.14-arm64.AppImage");
    expect(pickReleaseFile(files, "mac", "arm64")?.url).toBe("Tau-0.7.14-arm64-mac.zip");
    expect(pickReleaseFile(files, "mac", "x64")?.url).toBe("Tau-0.7.14-mac.zip");
    expect(pickReleaseFile(files, "windows", "x64")?.url).toBe("Tau-Setup-0.7.14.exe");
    expect(pickReleaseFile([file("../../etc/Tau_0.7.14_amd64.deb/../x")], "deb", "x64")).toBeUndefined();
    expect(safeReleaseName("a/b/..%2F..%2Fpasswd")).toBeUndefined();
    expect(safeReleaseName(".hidden.deb")).toBeUndefined();
  });

  it("accepts a signature only by a listed key over exactly the bytes signed", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    const pem = String(publicKey.export({ format: "pem", type: "spki" }));
    const text = "version: 0.7.14\n";
    const signature = sign(null, Buffer.from(text), privateKey).toString("base64");
    expect(verifyReleaseSignature(text, signature, [raw])).toBe(true);
    expect(verifyReleaseSignature(text, signature, [pem])).toBe(true);
    expect(verifyReleaseSignature(`${text} `, signature, [raw])).toBe(false);
    expect(verifyReleaseSignature(text, signature, [])).toBe(false);
    expect(verifyReleaseSignature(text, "not base64 at all", [raw])).toBe(false);
  });
});
