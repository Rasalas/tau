import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importSessionFile, rewriteImportedSession } from "./session-import.js";
import { ORIGIN_ENTRY, PARENT_LINK_ENTRY, parentLinkEntry, readSessionLineage } from "./session-lineage.js";

const SOURCE_CWD = "/Users/a/work/project";

const header = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "session", version: 3, id: "source-id", timestamp: "2026-09-25T10:00:00.000Z", cwd: SOURCE_CWD, parentSession: "/Users/a/.pi/agent/sessions/x.jsonl", ...extra });

const user = (id: string, parentId: string | null, text: string) =>
  JSON.stringify({ type: "message", id, parentId, timestamp: "2026-09-25T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });

const assistant = (id: string, parentId: string, text: string) =>
  JSON.stringify({
    type: "message", id, parentId, timestamp: "2026-09-25T10:00:02.000Z",
    message: { role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
  });

const toolResult = (id: string, parentId: string) =>
  JSON.stringify({
    type: "message", id, parentId, timestamp: "2026-09-25T10:00:03.000Z",
    message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: `${SOURCE_CWD}/src/index.ts: 12 lines` }], isError: false, timestamp: 3 },
  });

const custom = (id: string, parentId: string | null, customType: string, data: unknown) =>
  JSON.stringify({ type: "custom", customType, data, id, parentId, timestamp: "2026-09-25T10:00:00.500Z" });

const origin = { hostId: "host-a", threadId: "thread-a" };

function rewrite(jsonl: string, extra: Partial<Parameters<typeof rewriteImportedSession>[1]> = {}) {
  return rewriteImportedSession(jsonl, { cwd: "/home/rex/work/project", sessionId: "new-id", timestamp: "2026-09-25T12:00:00.000Z", origin, ...extra });
}

function lines(text: string): Array<Record<string, unknown>> {
  return text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("rewriting a session from another machine", () => {
  it("gives it a new id and this machine's folder, and puts its origin right after the header", () => {
    const source = [header(), user("u1", null, "hello"), assistant("a1", "u1", "hi"), toolResult("t1", "a1")].join("\n");
    const [head, originLine, ...rest] = lines(rewrite(source).text);

    expect(head).toEqual({ type: "session", version: 3, id: "new-id", timestamp: "2026-09-25T12:00:00.000Z", cwd: "/home/rex/work/project" });
    expect(originLine).toMatchObject({ type: "custom", customType: ORIGIN_ENTRY, parentId: null, data: { version: 1, hostId: "host-a", threadId: "thread-a" } });
    // The old root hangs off the origin entry; everything else is copied as it was.
    expect(rest.map((entry) => [entry.id, entry.parentId])).toEqual([["u1", originLine!.id], ["a1", "u1"], ["t1", "a1"]]);
    expect(JSON.stringify(rest[2])).toContain(`${SOURCE_CWD}/src/index.ts`);
  });

  it("drops the origin and parent link of its old machine and moves their children up", () => {
    const source = [
      header(),
      custom("o1", null, ORIGIN_ENTRY, { version: 1, hostId: "host-z", threadId: "thread-z" }),
      custom("p1", "o1", PARENT_LINK_ENTRY, parentLinkEntry("parent-a")),
      user("u1", "p1", "hello"),
      assistant("a1", "u1", "hi"),
    ].join("\n");
    const out = lines(rewrite(source).text);

    expect(out.filter((entry) => entry.customType === PARENT_LINK_ENTRY)).toEqual([]);
    expect(out.filter((entry) => entry.customType === ORIGIN_ENTRY)).toHaveLength(1);
    expect(out[1]!.data).toMatchObject({ hostId: "host-a" });
    expect(out.find((entry) => entry.id === "u1")!.parentId).toBe(out[1]!.id);
  });

  it("names the thread after the last entry when a title is given", () => {
    const out = lines(rewrite([header(), user("u1", null, "hello"), assistant("a1", "u1", "hi")].join("\n"), { title: "Fix the\nbuild" }).text);
    expect(out.at(-1)).toMatchObject({ type: "session_info", parentId: "a1", name: "Fix the build" });
  });

  it("keeps details the importer stores beside the origin", () => {
    const out = lines(rewrite(`${header()}\n${user("u1", null, "hello")}\n`, { origin: { ...origin, details: { base: "abc123" } } }).text);
    expect(out[1]!.data).toEqual({ version: 1, base: "abc123", hostId: "host-a", threadId: "thread-a" });
  });

  it("refuses another format version", () => {
    expect(() => rewrite([header({ version: 2 }), user("u1", null, "hello")].join("\n"))).toThrow(/session format 2; this machine reads format 3/);
    expect(() => rewrite([header({ version: undefined }), user("u1", null, "hello")].join("\n"))).toThrow(/session format 1/);
    expect(() => rewrite([header({ version: 4 }), user("u1", null, "hello")].join("\n"))).toThrow(/session format 4/);
  });

  it("refuses an entry or a file over the limits", () => {
    const big = user("u1", null, "x".repeat(2_000));
    expect(() => rewrite([header(), big].join("\n"), { limits: { maxEntryBytes: 1_000 } })).toThrow(/line 2 is .* an entry may be at most/);
    expect(() => rewrite([header(), big].join("\n"), { limits: { maxBytes: 1_000 } })).toThrow(/the limit is/);
  });

  it("refuses what is not a session", () => {
    expect(() => rewrite("")).toThrow(/empty/);
    expect(() => rewrite(user("u1", null, "hello"))).toThrow(/not a session header/);
    expect(() => rewrite(`${header()}\n{broken`)).toThrow(/line 2 is not JSON/);
    expect(() => rewrite(`${header()}\n${JSON.stringify({ type: "message" })}`)).toThrow(/line 2 is not a session entry/);
    expect(() => rewrite(`${header()}\n${header()}`)).toThrow(/second session header/);
    expect(() => rewrite(`${header()}\n`, { origin: { hostId: "", threadId: "t" } })).toThrow(/origin/);
  });
});

describe("writing an imported session", () => {
  let root: string;
  let sessionsDir: string;
  let cwd: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tau-import-"));
    sessionsDir = join(root, "sessions");
    cwd = join(root, "project");
    await mkdir(cwd);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("lands in the sessions folder as a thread Pi resumes with the old history", async () => {
    const source = [header(), user("u1", null, "Say one word"), assistant("a1", "u1", "Hello")].join("\n");
    const imported = await importSessionFile({ cwd, jsonl: `${source}\n`, title: "Greeting", origin }, { sessionsDir });

    expect(imported.cwd).toBe(cwd);
    expect(imported.path.startsWith(sessionsDir)).toBe(true);
    expect(await readdir(sessionsDir)).toEqual([imported.path.slice(sessionsDir.length + 1)]);

    const manager = SessionManager.open(imported.path, sessionsDir);
    expect(manager.getSessionId()).toBe(imported.sessionId);
    expect(manager.getCwd()).toBe(cwd);
    expect(manager.getSessionName()).toBe("Greeting");
    const texts = manager.buildSessionContext().messages.map((message) => JSON.stringify(message));
    expect(texts.join(" ")).toContain("Say one word");
    expect(texts.join(" ")).toContain("Hello");

    // Continuing appends after the imported history.
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "again" }], timestamp: 4 });
    const written = lines(await readFile(imported.path, "utf8"));
    expect(written.at(-1)).toMatchObject({ type: "message", parentId: written.at(-2)!.id });

    const listed = await SessionManager.listAll(sessionsDir);
    expect(listed.map((info) => info.id)).toEqual([imported.sessionId]);
    await expect(readSessionLineage(imported.path)).resolves.toEqual({ origin });
  });

  it("refuses a folder that does not exist here and writes nothing", async () => {
    await expect(importSessionFile({ cwd: join(root, "missing"), jsonl: `${header()}\n`, origin }, { sessionsDir }))
      .rejects.toThrow(/no folder/);
    await expect(importSessionFile({ cwd: "relative/path", jsonl: `${header()}\n`, origin }, { sessionsDir }))
      .rejects.toThrow(/absolute/);
    await expect(importSessionFile({ cwd, jsonl: `${header({ version: 2 })}\n`, origin }, { sessionsDir }))
      .rejects.toThrow(/format 2/);
    await expect(readdir(sessionsDir)).rejects.toThrow();
  });
});
