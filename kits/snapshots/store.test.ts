import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SnapShotCapture } from "./protocol.js";
import { KEEP_MS, MAX_KEPT, SnapShotStore } from "./store.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const folder = async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-snapshots-"));
  directories.push(directory);
  return directory;
};

const PNG = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
const capture = (overrides: Partial<SnapShotCapture> = {}): SnapShotCapture => ({
  app: "Electron",
  title: "E18 test window",
  pid: 42,
  capturedAt: 1_000,
  image: { data: PNG, mimeType: "image/png", width: 2, height: 1 },
  accessibility: { imageSize: { width: 2, height: 1 }, truncated: false, nodes: 1, root: { role: "window", name: "E18 test window", children: [] } },
  ...overrides,
});

describe("the captures a composer has not sent", () => {
  it("keeps the picture and the tree on disk until they are released", async () => {
    const directory = await folder();
    const store = new SnapShotStore(directory, () => 2_000);
    const meta = await store.add(capture());

    expect(meta).toMatchObject({ app: "Electron", title: "E18 test window", size: 8, accessibility: { nodes: 1, truncated: false }, claimed: false });
    expect((await readdir(directory)).sort()).toEqual([`${meta.id}.json`, `${meta.id}.png`]);
    expect(await store.read(meta.id)).toMatchObject({ data: PNG, accessibility: { root: { role: "window" } } });

    // A second store over the same folder (the next run) finds it again.
    const again = new SnapShotStore(directory, () => 3_000);
    await again.load();
    expect(again.list().map((entry) => entry.id)).toEqual([meta.id]);

    await again.remove(meta.id);
    expect(await readdir(directory)).toEqual([]);
    expect(await again.read(meta.id)).toBeUndefined();
  });

  it("hands a capture to the first client that claims it", async () => {
    const store = new SnapShotStore(await folder(), () => 2_000);
    const meta = await store.add(capture());
    expect(await store.claim(meta.id)).toMatchObject({ id: meta.id, claimed: true });
    expect(await store.claim(meta.id)).toBeUndefined();
    expect(await store.claim("snap-unknown")).toBeUndefined();
  });

  it("drops what is older than a week, what it cannot parse, and the oldest beyond its limit", async () => {
    const directory = await folder();
    const old = new SnapShotStore(directory, () => 1_000);
    const stale = await old.add(capture({ capturedAt: 1_000 }));
    await writeFile(join(directory, "snap-broken.json"), "{");
    await writeFile(join(directory, "notes.json"), "{}");

    const later = new SnapShotStore(directory, () => 1_000 + KEEP_MS + 1);
    await later.load();
    expect(later.list()).toEqual([]);
    expect((await readdir(directory)).filter((name) => name.startsWith(stale.id) || name.startsWith("snap-broken"))).toEqual([]);

    const many = new SnapShotStore(await folder(), () => 5_000);
    for (let index = 0; index < MAX_KEPT + 2; index += 1) await many.add(capture({ capturedAt: 5_000 + index }));
    expect(many.list()).toHaveLength(MAX_KEPT);
    expect(many.list()[0]!.capturedAt).toBe(5_002);
  });

  it("never touches a file whose name is not a capture's", async () => {
    const directory = await folder();
    await writeFile(join(directory, "keep.png"), "x");
    await new SnapShotStore(directory).remove("../keep");
    expect(await readdir(directory)).toEqual(["keep.png"]);
  });
});
