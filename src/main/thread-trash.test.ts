import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ThreadTrash, type ThreadTrashPort } from "./thread-trash.js";

async function setup(options: { backend?: ThreadTrashPort["backend"]; retentionMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tau-trash-"));
  const sessions = join(root, "sessions");
  const dir = join(root, "trash");
  const deleted: Array<[string, string]> = [];
  let now = 1_000;
  const port: ThreadTrashPort = {
    backend: options.backend ?? (() => undefined),
    threadDeleted: async (sessionId, cwd) => { deleted.push([sessionId, cwd]); },
    log: () => undefined,
  };
  const trash = new ThreadTrash(port, { dir, retentionMs: options.retentionMs ?? 10_000, now: () => now });
  return { root, sessions, dir, trash, deleted, advance: (ms: number) => { now += ms; }, port };
}

describe("ThreadTrash", () => {
  it("moves a session file in and puts it back where it was", async () => {
    const { sessions, trash, deleted } = await setup();
    const path = join(sessions, "--repo--", "one.jsonl");
    await mkdir(join(sessions, "--repo--"), { recursive: true });
    await writeFile(path, "{\"type\":\"session\"}\n");

    const entry = await trash.trash({ sessionId: "one", cwd: "/repo", title: "First", backendKind: "pi", path });
    expect(entry).toMatchObject({ sessionId: "one", cwd: "/repo", title: "First", deletedAt: 1_000, purgeAt: 11_000 });
    expect(await readdir(join(sessions, "--repo--"))).toEqual([]);
    expect(trash.has("one")).toBe(true);

    await trash.restore("one");
    expect(await readFile(path, "utf8")).toBe("{\"type\":\"session\"}\n");
    expect(trash.has("one")).toBe(false);
    expect(deleted).toEqual([]);
  });

  it("refuses to restore over a file that took the thread's place", async () => {
    const { sessions, trash } = await setup();
    const path = join(sessions, "one.jsonl");
    await mkdir(sessions, { recursive: true });
    await writeFile(path, "old\n");
    await trash.trash({ sessionId: "one", cwd: "/repo", title: "", backendKind: "pi", path });
    await writeFile(path, "new\n");

    await expect(trash.restore("one")).rejects.toThrow(/already sits/u);
    expect(await readFile(path, "utf8")).toBe("new\n");
    expect(trash.has("one")).toBe(true);
  });

  it("purges only what is due and runs the deletion hooks then", async () => {
    const { sessions, trash, deleted, advance, dir } = await setup({ retentionMs: 5_000 });
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "a.jsonl"), "a\n");
    await writeFile(join(sessions, "b.jsonl"), "b\n");
    await trash.trash({ sessionId: "a", cwd: "/a", title: "", backendKind: "pi", path: join(sessions, "a.jsonl") });
    advance(3_000);
    await trash.trash({ sessionId: "b", cwd: "/b", title: "", backendKind: "pi", path: join(sessions, "b.jsonl") });

    advance(2_500);
    await trash.purgeDue();
    trash.dispose();

    expect(deleted).toEqual([["a", "/a"]]);
    expect(trash.list().map((entry) => entry.sessionId)).toEqual(["b"]);
    expect((await readdir(dir)).sort()).toEqual(["b", "trash.json"]);
  });

  it("keeps its entries across a restart", async () => {
    const { sessions, trash, dir, port } = await setup();
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "a.jsonl"), "a\n");
    await trash.trash({ sessionId: "a", cwd: "/a", title: "Kept", backendKind: "pi", path: join(sessions, "a.jsonl") });
    trash.dispose();

    const again = new ThreadTrash(port, { dir });
    await again.load();
    expect(again.list()).toMatchObject([{ sessionId: "a", title: "Kept" }]);
    await again.restore("a");
    expect(await readFile(join(sessions, "a.jsonl"), "utf8")).toBe("a\n");
  });

  it("takes a backend's shell record and hands the same record back", async () => {
    const store = new Map<string, unknown>([["ext", { tauThreadId: "ext", messages: ["hi"] }]]);
    const backend = {
      label: "Codex",
      removeThread: async (id: string) => { const record = store.get(id); store.delete(id); return record; },
      restoreThread: async (id: string, record: unknown) => { store.set(id, record); },
    };
    const { trash, deleted } = await setup({ backend: (kind) => kind === "codex" ? backend : undefined });

    await trash.trash({ sessionId: "ext", cwd: "/repo", title: "", backendKind: "codex", path: "codex:ext" });
    expect(store.has("ext")).toBe(false);
    await trash.restore("ext");
    expect(store.get("ext")).toEqual({ tauThreadId: "ext", messages: ["hi"] });

    await trash.trash({ sessionId: "ext", cwd: "/repo", title: "", backendKind: "codex", path: "codex:ext" });
    await trash.purge("ext");
    expect(store.has("ext")).toBe(false);
    expect(deleted).toEqual([["ext", "/repo"]]);
  });

  it("refuses a backend that cannot hand its threads over", async () => {
    const { trash } = await setup({ backend: () => ({ label: "Other" }) });
    await expect(trash.trash({ sessionId: "x", cwd: "/repo", title: "", backendKind: "other", path: "other:x" })).rejects.toThrow(/Other threads cannot be deleted/u);
    expect(trash.list()).toEqual([]);
  });
});
