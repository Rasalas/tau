import { createReadStream } from "node:fs";
import { appendFile, mkdir, mkdtemp, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionInfoIndex } from "./session-info-index.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, createReadStream: vi.fn(fs.createReadStream) };
});

const roots: string[] = [];
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tau-session-info-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.mocked(createReadStream).mockClear();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function session(id: string): string {
  return JSON.stringify({ type: "session", version: 3, id, cwd: "/repo", timestamp: "2026-10-12T10:00:00Z" }) + "\n";
}
function message(id: string, timestamp: number): string {
  return JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-10-12T10:00:01Z", message: { role: "user", content: [{ type: "text", text: id }], timestamp } }) + "\n";
}

describe("SessionInfoIndex", () => {
  it.each([false, true])("distinguishes an empty store from unreadable folders and session files, full read %s", async (readFiles) => {
    const root = await directory();
    expect((await new SessionInfoIndex(join(root, "missing")).list(readFiles)).complete).toBe(true);
    const blocked = join(root, "not-a-directory");
    await writeFile(blocked, "fixture");
    expect((await new SessionInfoIndex(blocked).list(readFiles)).complete).toBe(false);
    const broken = join(root, "broken.jsonl");
    await writeFile(broken, "invalid session\n");
    const index = new SessionInfoIndex(root);
    expect((await index.list(readFiles)).complete).toBe(false);
    await writeFile(broken, session("recovered"));
    expect((await index.list(readFiles)).complete).toBe(true);
  });

  it.each([false, true])("marks a failed nested Pi folder scan incomplete, full read %s", async (readFiles) => {
    const root = await directory();
    const sessions = join(root, "sessions");
    await mkdir(sessions);
    await symlink(join(root, "missing"), join(sessions, "project"));
    vi.stubEnv("PI_CODING_AGENT_DIR", root);
    expect((await new SessionInfoIndex().list(readFiles)).complete).toBe(false);
  });

  it("reads past a stamp collision and replaces the stale cache entry", async () => {
    const root = await directory();
    const path = join(root, "one.jsonl");
    const at = new Date("2026-10-12T10:00:00Z");
    await writeFile(path, session("one"));
    await utimes(path, at, at);
    const before = await stat(path);
    const index = new SessionInfoIndex(root);
    expect((await index.list()).infos[0]?.id).toBe("one");
    await writeFile(path, session("two"));
    await utimes(path, at, at);
    const after = await stat(path);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    expect((await index.list()).infos[0]?.id).toBe("two");
    expect((await index.list(true)).infos[0]?.id).toBe("two");
    expect((await index.list()).infos[0]?.id).toBe("two");
  });

  it("restores unchanged shell metadata and model without rereading history after restart", async () => {
    const root = await directory();
    const path = join(root, "one.jsonl");
    const file = join(root, "cache", "info.json");
    await writeFile(path, session("one") + message("hello", 1) + JSON.stringify({ type: "model_change", id: "model", provider: "fixture", modelId: "selected" }) + "\n");
    const writer = new SessionInfoIndex(root, { file });
    const first = await writer.list();
    await writer.dispose();
    vi.mocked(createReadStream).mockClear();
    const restored = await new SessionInfoIndex(root, { file }).list();
    expect(restored.infos).toEqual(first.infos);
    expect(restored.models.get("one")).toEqual({ provider: "fixture", id: "selected" });
    expect(createReadStream).not.toHaveBeenCalled();
    await appendFile(path, message("changed", 2));
    expect((await new SessionInfoIndex(root, { file }).list()).infos[0]?.messageCount).toBe(2);
    expect(createReadStream).toHaveBeenCalledOnce();
  });

  it("writes the cache compactly once scans pause, keeping only the prompt text a title reads", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const root = await directory();
      const path = join(root, "one.jsonl");
      const file = join(root, "cache", "info.json");
      const prompt = `Rename   the\nwidget. ${"x".repeat(5_000)}`;
      await writeFile(path, session("one") + JSON.stringify({ type: "message", id: "u", parentId: null, message: { role: "user", content: prompt, timestamp: 1 } }) + "\n");
      const index = new SessionInfoIndex(root, { file });
      await index.list();
      await appendFile(path, message("more", 2));
      await index.list();
      const { readFile } = await import("node:fs/promises");
      await expect(readFile(file, "utf8")).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(10_000);
      await index.flush();
      const written = await readFile(file, "utf8");
      expect(written).not.toContain("\n");
      const restored = (await new SessionInfoIndex(root, { file }).list()).infos[0]!;
      expect(restored.messageCount).toBe(2);
      expect(restored.firstMessage).toBe(`Rename the widget. ${"x".repeat(181)}`);
    } finally { vi.useRealTimers(); }
  });

  it("ignores corrupt and newer-version caches without trusting their metadata", async () => {
    const root = await directory();
    const path = join(root, "one.jsonl");
    const file = join(root, "cache.json");
    await writeFile(path, session("one"));
    await writeFile(file, "broken");
    expect((await new SessionInfoIndex(root, { file, logger: { warn: () => {} } }).list()).infos[0]?.id).toBe("one");
    const future = JSON.stringify({ version: 999, entries: [] });
    await writeFile(file, future);
    expect((await new SessionInfoIndex(root, { file, logger: { warn: () => {} } }).list()).infos[0]?.id).toBe("one");
    expect(await import("node:fs/promises").then(({ readFile }) => readFile(file, "utf8"))).toBe(future);
  });

  it("keeps a directly listed session when no file stamp is available", async () => {
    const root = await directory();
    const info = {
      path: join(root, "saved.jsonl"), id: "saved", cwd: "/repo", created: new Date(1), modified: new Date(2),
      messageCount: 2, firstMessage: "earlier", allMessagesText: "earlier",
    };
    const listing = vi.spyOn(SessionManager, "listAll").mockResolvedValue([info]);
    try {
      const result = await new SessionInfoIndex(root).list(true);
      expect(result.infos).toEqual([{ ...info, allMessagesText: "" }]);
      expect(result.stamps.has(info.path)).toBe(false);
      expect(result.complete).toBe(false);
    } finally { listing.mockRestore(); }
  });

  it("keeps SDK metadata without certifying an independently unreadable session", async () => {
    const root = await directory();
    const path = join(root, "saved.jsonl");
    await writeFile(path, "invalid session\n");
    const info = { path, id: "saved", cwd: "/repo", created: new Date(1), modified: new Date(2), messageCount: 0, firstMessage: "earlier", allMessagesText: "" };
    const listing = vi.spyOn(SessionManager, "listAll").mockResolvedValue([info]);
    try {
      const result = await new SessionInfoIndex(root).list(true);
      expect(result.infos).toEqual([info]);
      expect(result.complete).toBe(false);
    } finally { listing.mockRestore(); }
  });

  it("reuses unchanged files, including a cached absence of model, and rereads only changed files", async () => {
    const root = await directory();
    const a = join(root, "a.jsonl");
    const b = join(root, "b.jsonl");
    await writeFile(a, session("a") + message("hello", 1));
    await writeFile(b, session("b"));
    const index = new SessionInfoIndex(root);
    const first = await index.list();
    expect(first.models.has("a")).toBe(true);
    expect(first.models.get("a")).toBeUndefined();
    vi.mocked(createReadStream).mockClear();
    expect((await index.list()).infos).toEqual(first.infos);
    expect(createReadStream).not.toHaveBeenCalled();
    await appendFile(a, message("new", 2));
    const changed = await index.list();
    expect(changed.infos.find((info) => info.id === "a")?.messageCount).toBe(2);
    expect(vi.mocked(createReadStream).mock.calls.map(([path]) => path)).toEqual([a]);
    await appendFile(a, JSON.stringify({ type: "model_change", id: "model", parentId: null, provider: "fixture", modelId: "selected" }) + "\n");
    expect((await index.list()).models.get("a")).toEqual({ provider: "fixture", id: "selected" });
  });

  it("invalidates on either mtime or size and drops renamed and deleted paths", async () => {
    const root = await directory();
    const path = join(root, "a.jsonl");
    await writeFile(path, session("a"));
    const index = new SessionInfoIndex(root);
    await index.list();
    const before = await stat(path);
    await writeFile(path, session("b"));
    await utimes(path, before.atime, new Date(before.mtimeMs + 2000));
    expect((await index.list()).infos[0]?.id).toBe("b");
    const stamp = await stat(path);
    await appendFile(path, message("new", 2));
    await utimes(path, stamp.atime, stamp.mtime);
    expect((await index.list()).infos[0]?.messageCount).toBe(1);
    const moved = join(root, "moved.jsonl");
    await rename(path, moved);
    const renamed = await index.list();
    expect(renamed.infos.map((info) => info.path)).toEqual([moved]);
    expect(renamed.stamps.has(path)).toBe(false);
    await rm(moved);
    expect((await index.list()).infos).toEqual([]);
    await writeFile(path, session("restored"));
    expect((await index.list()).infos[0]?.id).toBe("restored");
  });

  it("matches the SDK's shell metadata for malformed lines, latest names and message activity", async () => {
    const root = await directory();
    await writeFile(join(root, "a.jsonl"), session("a") + "broken\n" + message("hello", 2000) +
      JSON.stringify({ type: "session_info", name: "  Renamed  " }) + "\n" +
      JSON.stringify({ type: "message", message: { role: "assistant", content: "reply", timestamp: 1000 } }) + "\n" +
      JSON.stringify({ type: "message", message: { role: "toolResult", content: "tool", timestamp: 9000 } }) + "\n");
    const sdk = await SessionManager.listAll(root);
    const index = new SessionInfoIndex(root);
    const actual = (await index.list()).infos;
    expect(actual.map((info) => ({ ...info, allMessagesText: "" }))).toEqual(sdk.map((info) => ({ ...info, allMessagesText: "" })));
    await appendFile(join(root, "a.jsonl"), JSON.stringify({ type: "session_info", name: "" }) + "\n");
    expect((await index.list()).infos[0]?.name).toBeUndefined();
  });

  it("discovers the default workspace folders and symlinks, but keeps custom directories flat", async () => {
    const root = await directory();
    vi.stubEnv("PI_CODING_AGENT_DIR", root);
    const sessions = join(root, "sessions");
    const workspace = join(sessions, "workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "a.jsonl"), session("a"));
    await writeFile(join(sessions, "flat.jsonl"), session("flat"));
    const linked = join(root, "linked");
    await mkdir(linked);
    await writeFile(join(linked, "b.jsonl"), session("b"));
    await symlink(linked, join(sessions, "link"), "dir");
    expect((await new SessionInfoIndex().list()).infos.map((info) => info.id).sort()).toEqual(["a", "b"]);
    expect((await new SessionInfoIndex(sessions).list()).infos.map((info) => info.id)).toEqual(["flat"]);
  });

  it("finds a directory created later and retries a partial header when its stamp changes", async () => {
    const root = join(await directory(), "later");
    const index = new SessionInfoIndex(root);
    expect((await index.list()).infos).toEqual([]);
    await mkdir(root);
    const path = join(root, "a.jsonl");
    await writeFile(path, "{\"type\":");
    expect((await index.list()).infos).toEqual([]);
    await writeFile(path, session("a"));
    expect((await index.list()).infos[0]?.id).toBe("a");
  });
});
