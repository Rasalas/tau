import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readFeed, releaseBase } from "../../bin/tau-update-helper.mjs";
import { releaseFeedUrl } from "../../src/main/appimage-install.ts";
import { readUpdateFeed, releaseFeedBase, releaseFileUrl } from "../../src/main/release-feed.ts";
import { githubReleaseNotes } from "../../src/main/release-notes.ts";
import { ROOT } from "./release.mjs";

vi.mock("electron", () => ({ dialog: { showMessageBox: vi.fn() } }));
const { feedFor } = await import("../../src/main/app-updates.ts");

/** `publish:` of tooling/electron-builder.yml as the build writes it into `resources/app-update.yml`. */
function appUpdateYml() {
  const builder = readFileSync(join(ROOT, "tooling", "electron-builder.yml"), "utf8");
  const block = /^publish:\n((?:[ \t]+.*\n?)+)/mu.exec(builder)?.[1];
  if (!block) throw new Error("tooling/electron-builder.yml has no publish block");
  return `${block.replace(/^[ \t]+/gmu, "")}updaterCacheDirName: tau-pi-desktop-prototype-updater\n`;
}

const PUBLIC = "https://github.com/Rasalas/tau/releases";

describe("the update feed an installed Tau reads", () => {
  it("keeps older apps on their embedded feed until they install the migration build", () => {
    const oldConfig = "provider: github\nowner: Rasalas\nrepo: tau-releases\n";
    const oldFeed = readUpdateFeed(oldConfig);
    expect(feedFor("stable", oldFeed)).toEqual({ provider: "github", owner: "Rasalas", repo: "tau-releases" });
    expect(feedFor("nightly", oldFeed)).toEqual({ provider: "generic", url: "https://github.com/Rasalas/tau-releases/releases/download/nightly" });
    expect(releaseBase(readFeed(oldConfig), "0.7.44", "stable")).toBe("https://github.com/Rasalas/tau-releases/releases/download/v0.7.44/");
    expect(releaseFeedBase("stable", oldFeed)).toBe("https://github.com/Rasalas/tau-releases/releases/latest/download/");
  });

  it("uses the public source repository for new builds", () => {
    expect(readUpdateFeed(appUpdateYml())).toEqual({ owner: "Rasalas", repo: "tau" });
    expect(readFeed(appUpdateYml())).toEqual({ owner: "Rasalas", repo: "tau" });
  });

  it("sends the window's updater, the host, the AppImage's offer and the helper there", () => {
    const feed = readUpdateFeed(appUpdateYml());
    expect(feedFor("stable", feed)).toEqual({ provider: "github", owner: "Rasalas", repo: "tau" });
    expect(feedFor("nightly", feed)).toEqual({ provider: "generic", url: `${PUBLIC}/download/nightly` });
    expect(releaseFeedBase("stable", feed)).toBe(`${PUBLIC}/latest/download/`);
    expect(releaseFeedBase("nightly", feed)).toBe(`${PUBLIC}/download/nightly/`);
    expect(releaseFileUrl("Tau_0.7.15_amd64.deb", "0.7.15", "stable", releaseFeedBase("stable", feed), feed)).toBe(`${PUBLIC}/download/v0.7.15/Tau_0.7.15_amd64.deb`);
    expect(releaseFeedUrl("0.7.15", feed, {})).toBe(`${PUBLIC}/download/v0.7.15/`);
    expect(releaseBase(readFeed(appUpdateYml()), "0.7.15", "stable")).toBe(`${PUBLIC}/download/v0.7.15/`);
    expect(releaseBase(readFeed(appUpdateYml()), "0.7.16-nightly.20260930.4", "nightly")).toBe(`${PUBLIC}/download/nightly/`);
  });

  it("reads the release notes from the public release, without a token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ body: "- one", html_url: `${PUBLIC}/tag/v0.7.15` })));
    const notes = await githubReleaseNotes(readUpdateFeed(appUpdateYml()), fetchImpl).read("0.7.15");
    expect(notes).toEqual({ body: "- one", url: `${PUBLIC}/tag/v0.7.15` });
    expect(fetchImpl).toHaveBeenCalledWith("https://api.github.com/repos/Rasalas/tau/releases/tags/v0.7.15", expect.not.objectContaining({ headers: expect.objectContaining({ authorization: expect.anything() }) }));
  });
});
