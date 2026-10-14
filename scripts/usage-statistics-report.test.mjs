import { expect, test } from "vitest";
import { assetKind, formatReport, summarizeDownloads } from "./usage-statistics-report.mjs";

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
