import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistentMessageIndex, type IndexIdentity } from "./persistent-index.js";
import * as piStream from "./pi-text-stream.js";
import { queryTokens } from "./threads.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const message = (text: string, role = "assistant") => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
async function fixture(content: string) {
  const root = await mkdtemp(join(tmpdir(), "tau-message-index-")); roots.push(root);
  const path = join(root, "session.jsonl"); await writeFile(path, content);
  const identity: IndexIdentity = { source: "pi", id: "thread", path };
  const index = new PersistentMessageIndex(join(root, "state"));
  const find = (query: string, reader = index) => reader.searchPi(identity, queryTokens(query));
  return { root, path, identity, index, find };
}

describe("persistent message index", () => {
  it("finds the middle of a giant single JSON message and cooccurring distant tokens without clipping", async () => {
    const { find, index } = await fixture(message(`opening ${"x".repeat(450_000)} middle beacon ${"y".repeat(450_000)} final quasar`));
    expect(await find("middle beacon")).toMatchObject({ match: { role: "assistant", quality: 31, snippet: expect.stringContaining("middle beacon") } });
    expect(await find("opening quasar")).toMatchObject({ match: { quality: 30, snippet: expect.stringContaining("opening") } });
    expect(index.stats).toEqual({ sourceReads: 1, rebuilds: 1 });
  });

  it("reuses the versioned index after restart without reading the source again", async () => {
    const { root, find, index } = await fixture(message("restart crystal"));
    expect(await find("crystal")).toBeDefined();
    const restarted = new PersistentMessageIndex(join(root, "state"));
    expect(await find("crystal", restarted)).toEqual(await find("crystal", index));
    expect(restarted.stats).toEqual({ sourceReads: 0, rebuilds: 0 });
    expect((await restarted.catalog()).map((entry) => entry.id)).toEqual(["thread"]);
  });

  it("invalidates a same-size rewrite with restored mtime, append, truncation, atomic replacement and deletion", async () => {
    const { root, path, find, identity, index } = await fixture(message("first crystal"));
    await find("first");
    const original = await stat(path);
    await writeFile(path, message("other crystal"));
    await utimes(path, original.atime, original.mtime);
    expect(await find("first")).toBeUndefined();
    expect(await find("other")).toBeDefined();
    await appendFile(path, "\n" + message("appended comet"));
    expect(await find("comet")).toBeDefined();
    await writeFile(path, message("short"));
    expect(await find("comet")).toBeUndefined();
    const replacement = join(root, "replacement");
    await writeFile(replacement, message("replacement nova"));
    await rename(replacement, path);
    expect(await find("nova")).toBeDefined();
    expect(await find("short")).toBeUndefined();
    await rm(path);
    expect(await find("nova")).toBeUndefined();
    expect(await index.catalog()).toEqual([]);
    await writeFile(path, message("recreated pulsar"));
    expect(await find("pulsar")).toBeDefined();
    await index.prunePi([]);
    expect(await index.catalog()).toEqual([]);
    expect(await index.searchPi(identity, ["pulsar"])).toBeDefined();
  });

  it("retries a source that changes during extraction and never mixes the two versions", async () => {
    const { path, find, index } = await fixture(message("obsolete crystal"));
    const original = piStream.piTextRecords;
    vi.spyOn(piStream, "piTextRecords").mockImplementationOnce(async function* (chunks) {
      yield* original(chunks);
      await writeFile(path, message("replacement nova"));
    });
    expect(await find("crystal")).toBeUndefined();
    expect(await find("nova")).toMatchObject({ match: { snippet: "replacement nova" } });
    expect(index.stats).toEqual({ sourceReads: 2, rebuilds: 1 });
    expect((await readdir(index.directory)).filter((name) => name.startsWith(".write-"))).toEqual([]);
  });

  it("commits only complete valid JSON lines and keeps roles, blocks and messages separate", async () => {
    const reordered = JSON.stringify({ message: { content: [{ text: "alpha", type: "text" }, { text: "beta", type: "text" }, { text: "hidden", type: "image" }], role: "user" }, type: "message" });
    const { path, find } = await fixture([
      reordered, message("other", "assistant"), message("toolsecret", "toolResult"),
      '{"type":"message","message":{"role":"assistant","content":"ghost"},"invalid":}',
      '{"type":"message","message":{"role":"assistant","content":"unfinished',
    ].join("\n"));
    expect(await find("alpha beta")).toMatchObject({ match: { role: "user", quality: 30 } });
    for (const query of ["alpha other", "hidden", "toolsecret", "ghost", "unfinished"]) expect(await find(query)).toBeUndefined();
    await appendFile(path, '"}}');
    expect(await find("unfinished")).toMatchObject({ match: { role: "assistant" } });
  });

  it("rebuilds an interrupted, obsolete or corrupt generation instead of returning mixed results", async () => {
    const { index, path, find } = await fixture(message("original crystal"));
    await find("crystal");
    const file = join(index.directory, (await readdir(index.directory)).find((name) => name.endsWith(".index"))!);
    const valid = await readFile(file);
    for (const corrupt of [valid.subarray(0, 100), Buffer.from(valid.toString().replace('"version":1', '"version":0')), Buffer.from(valid.toString().replace("original crystal", "invented crystal"))]) {
      await writeFile(file, corrupt);
      expect(await find("crystal")).toMatchObject({ match: { snippet: "original crystal" } });
    }
    await writeFile(path, message("new nova"));
    await writeFile(join(index.directory, ".write-12345678-abcd"), valid);
    expect(await find("crystal")).toBeUndefined();
    expect(await find("nova")).toBeDefined();
    expect((await readdir(index.directory)).filter((name) => name.endsWith(".index"))).toHaveLength(1);
  });

  it("uses private files and refuses index symlinks without writing through them", async () => {
    const { root, index, find } = await fixture(message("private crystal"));
    await find("crystal");
    const files = await readdir(index.directory);
    expect(files.filter((name) => name.startsWith(".write-"))).toEqual([]);
    const path = join(index.directory, files.find((name) => name.endsWith(".index"))!);
    if (process.platform !== "win32") {
      expect((await lstat(index.directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      const outside = join(root, "unrelated"); await writeFile(outside, "untouched");
      await rm(path); await symlink(outside, path);
      expect(await find("crystal")).toBeDefined();
      expect(await readFile(outside, "utf8")).toBe("untouched");
      const unsafeState = join(root, "unsafe"); await mkdir(unsafeState);
      const outsideDir = join(root, "outside"); await mkdir(outsideDir);
      await symlink(outsideDir, join(unsafeState, "messages-v1"));
      await expect(new PersistentMessageIndex(unsafeState).catalog()).rejects.toThrow("Unsafe search index directory");
    }
  });

  it("never reuses another source or path's text for a repeated id", async () => {
    const { root, identity, index, find } = await fixture(message("Pi crystal"));
    await find("crystal");
    await index.putRuntime("runtime", identity.id, 10, [{ role: "user", text: "runtime nova" }]);
    expect(await index.searchRuntime("runtime", identity.id, ["crystal"])).toBeUndefined();
    expect(await find("nova")).toBeUndefined();
    const forkPath = join(root, "fork.jsonl"); await writeFile(forkPath, message("fork pulsar"));
    expect(await index.searchPi({ ...identity, path: forkPath }, ["crystal"])).toBeUndefined();
    await index.prunePi([{ ...identity, path: forkPath }]);
    expect((await index.catalog()).map((entry) => entry.path).sort()).toEqual(["", forkPath].sort());
  });
});

describe("paged runtime generation publication", () => {
  it("keeps the previous generation on interrupted or unfinished messages", async () => {
    const { index } = await fixture("");
    await index.putRuntime("runtime", "thread", 1, [{ role: "user", text: "old crystal" }]);
    await expect(index.putRuntimeStream("runtime", "thread", 1, "changed", async function* () {
      yield { messageId: "0", role: "assistant", offset: 0, text: "partial beacon", end: false };
      throw new Error("version changed");
    })).rejects.toThrow("version changed");
    await expect(index.putRuntimeStream("runtime", "thread", 1, "unfinished", async function* () {
      yield { messageId: "0", role: "assistant", offset: 0, text: "unfinished nova", end: false };
    })).rejects.toThrow("Unfinished runtime message");
    expect(await index.searchRuntime("runtime", "thread", ["crystal"])).toBeDefined();
    expect(await index.searchRuntime("runtime", "thread", ["beacon"])).toBeUndefined();
    expect(await index.searchRuntime("runtime", "thread", ["nova"])).toBeUndefined();
    expect((await readdir(index.directory)).filter(name => name.startsWith(".write-"))).toEqual([]);
  });

  it("rejects skipped offsets, interleaved messages and repeated message ids", async () => {
    const { index } = await fixture("");
    for (const next of [
      { messageId: "0", role: "user" as const, offset: 9, text: "gap", end: true },
      { messageId: "1", role: "user" as const, offset: 0, text: "interleaved", end: true },
    ]) {
      await expect(index.putRuntimeStream("runtime", "thread", 1, JSON.stringify(next), async function* () {
        yield { messageId: "0", role: "user", offset: 0, text: "first", end: false };
        yield next;
      })).rejects.toThrow("Incomplete runtime message");
    }
    await expect(index.putRuntimeStream("runtime", "thread", 1, "repeated", async function* () {
      yield { messageId: "0", role: "user", offset: 0, text: "first", end: true };
      yield { messageId: "0", role: "user", offset: 0, text: "repeat", end: true };
    })).rejects.toThrow("Invalid runtime message order");
    expect(await index.catalog()).toEqual([]);
  });

  it("streams distant tokens of a single message and reuses its persisted revision lazily", async () => {
    const { root, index } = await fixture("");
    const content = "opening " + "x".repeat(150_000) + " distant comet";
    const chunks = vi.fn(async function* () {
      for (let at = 0; at < content.length; at += 16_384) yield {
        messageId: "0", role: "assistant" as const, offset: at,
        text: content.slice(at, at + 16_384), end: at + 16_384 >= content.length,
      };
    });
    await index.putRuntimeStream("runtime", "thread", 1, "durable-revision", chunks);
    expect(await index.searchRuntime("runtime", "thread", ["opening", "comet"])).toBeDefined();
    const restarted = new PersistentMessageIndex(join(root, "state"));
    await restarted.putRuntimeStream("runtime", "thread", 1, "durable-revision", chunks);
    expect(chunks).toHaveBeenCalledTimes(1);
    await restarted.putRuntimeStream("runtime", "thread", 1, "new-revision-same-time", async function* () {
      yield { messageId: "0", role: "user", offset: 0, text: "new nova", end: true };
    });
    expect(await restarted.searchRuntime("runtime", "thread", ["comet"])).toBeUndefined();
    expect(await restarted.searchRuntime("runtime", "thread", ["nova"])).toBeDefined();
  });
});
