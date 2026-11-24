import { expect, test } from "vitest";
import { assetKind, feedPlatform, formatReport, matomoImage, mergeReleases, summarizeDownloads } from "./usage-statistics-report.mjs";

const asset = (name, download_count) => ({ name, download_count });
const releases = [
  { tag_name: "v0.7.41", published_at: "2026-10-12T15:28:57Z", assets: [asset("Tau-mac-arm64.dmg", 3), asset("Tau-0.7.41-arm64-mac.zip", 5), asset("latest-mac.yml", 40)] },
  { tag_name: "v0.7.42", published_at: "2026-10-13T12:03:00Z", assets: [
    asset("Tau-linux-amd64.deb", 2), asset("Tau-0.7.42-arm64.dmg", 1), asset("Tau-0.7.42.dmg", 1), asset("Tau-0.7.42.apk", 1),
    asset("Tau_0.7.42_amd64.deb", 4), asset("Tau-Setup-0.7.42.exe", 1), asset("Tau-0.7.42-arm64-mac.zip.blockmap", 9),
    asset("Tau-host-0.7.42-linux-x64.tar.gz", 2), asset("LICENSE", 1),
  ] },
];

test("separates installers people download from update payloads and metadata", () => {
  expect(assetKind("Tau-windows-x64.exe")).toEqual({ kind: "installers", platform: "Windows" });
  expect(assetKind("Tau-Setup-0.7.42.exe")).toEqual({ kind: "updates" });
  expect(assetKind("Tau-0.7.42.AppImage")).toEqual({ kind: "updates" });
  expect(assetKind("Tau-host-0.7.42-win32-x64.zip")).toEqual({ kind: "hosts" });
  expect(assetKind("latest-linux.yml.sig")).toBeUndefined();
});

test("sums downloads per kind, platform and release, newest release first", () => {
  const summary = summarizeDownloads(releases);
  expect(summary).toMatchObject({ installers: 8, updates: 10, hosts: 2, installerPlatforms: { "macOS arm64": 4, "macOS x64": 1, "Linux deb": 2, Android: 1 } });
  expect(summary.releases.map(({ tag, installers, updates }) => [tag, installers, updates])).toEqual([["v0.7.42", 5, 5], ["v0.7.41", 3, 5]]);
});

test("prints downloads when the Matomo report is unavailable", () => {
  const text = formatReport({ generatedAt: "2026-10-14T09:12:00.000Z", usage: { error: "ssh: connect to host vps: timed out" }, downloads: summarizeDownloads(releases) });
  expect(text).toContain("unavailable: ssh: connect to host vps: timed out");
  expect(text).toMatch(/Installers\s+8\s+macOS arm64 4, Linux deb 2, macOS x64 1, Android 1/u);
  expect(text).toMatch(/v0\.7\.42\s+2026-10-13\s+5\s+5/u);
});

test("finds the official Matomo image and the server's own build of it", () => {
  expect(matomoImage("matomo:5-apache")).toBe(true);
  expect(matomoImage("local/matomo:5.13.0-php8.4.27")).toBe(true);
  expect(matomoImage("mariadb:11.4")).toBe(false);
  expect(matomoImage("matomo:4-apache")).toBe(false);
});

test("counts update checks per platform from the feed files, a release published twice once", () => {
  expect(feedPlatform("latest-mac.yml")).toBe("macOS");
  expect(feedPlatform("latest-linux-arm64.yml")).toBe("Linux");
  expect(feedPlatform("latest-arm64.yml")).toBe("Windows");
  expect(feedPlatform("latest-host-linux-x64.yml")).toBe("hosts");
  expect(feedPlatform("latest-mac.yml.sig")).toBeUndefined();
  const merged = mergeReleases([
    [{ tag_name: "v0.7.44", published_at: "2026-11-10T12:30:00Z", assets: [asset("latest-linux.yml", 59), asset("latest-mac.yml", 2)] }],
    [{ tag_name: "v0.7.44", published_at: "2026-11-10T12:20:00Z", assets: [asset("latest-linux.yml", 3), asset("latest.yml", 2), asset("latest-host-linux-x64.yml", 2)] }, ...releases],
  ]);
  const summary = summarizeDownloads(merged);
  expect(summary.releases[0]).toMatchObject({ tag: "v0.7.44", publishedAt: "2026-11-10T12:20:00Z", checks: { macOS: 2, Linux: 62, Windows: 2, hosts: 2 } });
  expect(summary.updateChecks).toEqual({ macOS: 42, Linux: 62, Windows: 2, hosts: 2 });
  const text = formatReport({ generatedAt: "2026-11-24T18:00:00.000Z", usage: { error: "offline" }, repository: { repository: "Rasalas/tau", views: 1, viewers: 1, clones: 297, cloners: 56, stars: 1, forks: 0 }, downloads: summary });
  expect(text).toMatch(/v0\.7\.44\s+2026-11-10\s+0\s+0\s+2\s+62\s+2\s+2/u);
  expect(text).toContain("clones 297 (56 unique, CI checkouts included)");
});
