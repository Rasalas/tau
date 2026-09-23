import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReleaseNotesStore, githubReleaseNotes, parseReleaseNotes, releaseNoteText, type ReleaseNotesSource } from "./release-notes.js";

const GENERATED = "## What's Changed\n* Finish both runtime kits: settings pages by @Rasalas in https://github.com/Rasalas/tau/pull/6\n* Faster [transcript](https://x.test) paging by @someone in https://github.com/Rasalas/tau/pull/7\n\n## New Contributors\n* @someone made their first contribution\n\n\n**Full Changelog**: https://github.com/Rasalas/tau/compare/v0.3.0...v0.4.0";

describe("release notes as a short list", () => {
  it("reads GitHub's generated notes as the changes alone", () => {
    expect(parseReleaseNotes(GENERATED, "0.4.0", "https://example.test/r")).toEqual({
      version: "0.4.0",
      items: ["Finish both runtime kits: settings pages", "Faster transcript paging"],
      totalItems: 2,
      url: "https://example.test/r",
    });
  });

  it("reads the HTML the update feed carries", () => {
    const html = "<h2>What&#39;s Changed</h2><ul><li>Zoom from the <strong>View</strong> menu</li><li>Paste &amp; keep plain text</li></ul>";
    expect(parseReleaseNotes(html, "0.5.0").items).toEqual(["Zoom from the View menu", "Paste & keep plain text"]);
  });

  it("keeps a dozen items and counts the rest", () => {
    const body = Array.from({ length: 20 }, (_, index) => `- change ${index + 1}`).join("\n");
    const notes = parseReleaseNotes(body, "1.0.0");
    expect(notes.items).toHaveLength(12);
    expect(notes.totalItems).toBe(20);
  });

  it("takes the note of the version from electron-updater's list", () => {
    expect(releaseNoteText([{ version: "0.3.0", note: "old" }, { version: "0.4.0", note: "new" }], "0.4.0")).toBe("new");
    expect(releaseNoteText("body", "0.4.0")).toBe("body");
    expect(releaseNoteText(null, "0.4.0")).toBeUndefined();
  });
});

describe("the release on GitHub", () => {
  it("asks for the version's tag, and the moving tag for a nightly", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ body: "- one", html_url: "https://github.com/o/r/releases/tag/v1.2.0" })));
    const source = githubReleaseNotes({ owner: "o", repo: "r" }, fetchImpl as unknown as typeof fetch);
    expect(await source.read("1.2.0")).toEqual({ body: "- one", url: "https://github.com/o/r/releases/tag/v1.2.0" });
    await source.read("1.2.1-nightly.20260922.4");
    expect(fetchImpl.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      "https://api.github.com/repos/o/r/releases/tags/v1.2.0",
      "https://api.github.com/repos/o/r/releases/tags/nightly",
    ]);
  });

  it("has nothing for a release it cannot read", async () => {
    const source = githubReleaseNotes({ owner: "o", repo: "r" }, (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch);
    expect(await source.read("1.2.0")).toBeUndefined();
  });
});

describe("showing them once after an update", () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  async function store(currentVersion: string, source?: ReleaseNotesSource) {
    dir ??= await mkdtemp(join(tmpdir(), "tau-release-notes-"));
    return new ReleaseNotesStore({ file: join(dir, "release-notes.json"), currentVersion, ...(source ? { source } : {}) });
  }

  it("offers nothing on the very first start", async () => {
    expect(await (await store("0.4.0")).pending()).toBeUndefined();
  });

  it("offers the new version's notes after an update until they were seen", async () => {
    const read = vi.fn(async () => ({ body: GENERATED }));
    await (await store("0.3.0")).start();
    const updated = await store("0.4.0", { read });
    expect((await updated.pending())?.items).toHaveLength(2);
    // A restart before the page showed them keeps them due.
    const again = await store("0.4.0", { read });
    expect((await again.pending())?.version).toBe("0.4.0");
    await again.seen("0.4.0");
    expect(await again.pending()).toBeUndefined();
    expect(await (await store("0.4.0", { read })).pending()).toBeUndefined();
    expect(read).toHaveBeenCalledWith("0.4.0");
  });

  it("uses the notes the download brought instead of asking again", async () => {
    const read = vi.fn(async () => ({ body: "- from the network" }));
    const before = await store("0.3.0");
    await before.start();
    await before.downloaded("0.4.0", [{ version: "0.4.0", note: "<ul><li>From the feed</li></ul>" }]);
    const after = await store("0.4.0", { read });
    expect((await after.pending())?.items).toEqual(["From the feed"]);
    expect(read).not.toHaveBeenCalled();
    await after.seen("0.4.0");
    expect(JSON.parse(await readFile(join(dir!, "release-notes.json"), "utf8"))).toEqual({ version: 1, lastVersion: "0.4.0" });
  });

  it("still says what version started when the notes cannot be read", async () => {
    await (await store("0.3.0")).start();
    const updated = await store("0.4.0", { read: async () => { throw new Error("offline"); } });
    expect(await updated.pending()).toEqual({ version: "0.4.0", items: [], totalItems: 0 });
  });

  it("starts over from a file it cannot parse", async () => {
    dir = await mkdtemp(join(tmpdir(), "tau-release-notes-"));
    await writeFile(join(dir, "release-notes.json"), "{ not json");
    expect(await (await store("0.4.0")).pending()).toBeUndefined();
  });
});
