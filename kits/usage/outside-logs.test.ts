import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeLine, codexLine, codexMeta, codexResponse, codexTokenCount } from "./fixtures.js";
import { openSqlite, readOpenCodeDatabase } from "./opencode-store.js";
import { claudeMayCarryUsage, ClaudeProjectParser, codexMayCarryUsage, CodexRolloutParser, readMarkedLines, type OutsideSession } from "./outside-logs.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function temp(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-usage-outside-"));
  directories.push(directory);
  return directory;
}

const T0 = Date.UTC(2026, 8, 20, 9);
const S = 1000;

function parse(parser: { line(line: string): void; finish(): OutsideSession }, lines: string[]): OutsideSession {
  for (const line of lines) parser.line(line);
  return parser.finish();
}

function figures(session: OutsideSession) {
  return session.records.map((record) => [record.at - T0, record.input, record.cacheRead, record.output, record.total]);
}

describe("Codex rollouts", () => {
  it("counts an older CLI's token_count events once each, by the step of the running total", () => {
    const session = parse(new CodexRolloutParser("file"), [
      codexMeta("s-legacy", "/work/alpha", T0),
      codexLine("turn_context", T0 + S, { model: "gpt-5.6-luna" }),
      codexTokenCount(T0 + 2 * S, { input: 100, cached: 40, output: 10 }, { input: 100, cached: 40, output: 10 }),
      // The CLI repeats an event; the repeat is no new response.
      codexTokenCount(T0 + 2 * S + 100, { input: 100, cached: 40, output: 10 }, { input: 100, cached: 40, output: 10 }),
      codexTokenCount(T0 + 3 * S, { input: 50, output: 5 }, { input: 150, cached: 40, output: 15 }),
    ]);
    expect(session.sessionId).toBe("s-legacy");
    expect(session.cwd).toBe("/work/alpha");
    expect(figures(session)).toEqual([[2 * S, 60, 40, 10, 110], [3 * S, 50, 0, 5, 55]]);
    expect(session.records.every((record) => record.model === "gpt-5.6-luna" && record.provider === "openai")).toBe(true);
  });

  it("lets a current CLI's response records replace the counters from their first one on", () => {
    const session = parse(new CodexRolloutParser("file"), [
      codexMeta("s-new", "/work/alpha", T0),
      codexTokenCount(T0 + S, { input: 20, output: 2 }, { input: 20, output: 2 }),
      codexResponse(T0 + 2 * S, "resp-1", { input: 30, cached: 10, output: 3 }),
      codexTokenCount(T0 + 2 * S, { input: 30, cached: 10, output: 3 }, { input: 50, cached: 10, output: 5 }),
      codexResponse(T0 + 3 * S, "resp-2", { input: 40, output: 4 }),
    ]);
    expect(figures(session).sort((left, right) => left[0]! - right[0]!)).toEqual([[S, 20, 0, 2, 22], [2 * S, 20, 10, 3, 33], [3 * S, 40, 0, 4, 44]]);
    expect(session.records.map((record) => record.key).filter((key) => key.startsWith("codex:resp-"))).toEqual(["codex:resp-1", "codex:resp-2"]);
  });

  it("skips the burst a fork replays from its parent and names the parent", () => {
    const session = parse(new CodexRolloutParser("file"), [
      codexMeta("s-fork", "/work/alpha", T0, { forked_from_id: "s-parent" }),
      codexTokenCount(T0 + 10, { input: 100, output: 10 }, { input: 100, output: 10 }),
      codexTokenCount(T0 + 500, { input: 100, output: 10 }, { input: 200, output: 20 }),
      codexTokenCount(T0 + 1200, { input: 100, output: 10 }, { input: 300, output: 30 }),
      codexTokenCount(T0 + 60 * S, { input: 50, output: 5 }, { input: 350, output: 35 }),
    ]);
    expect(session.parentId).toBe("s-parent");
    expect(figures(session)).toEqual([[60 * S, 50, 0, 5, 55]]);
  });

  it("names the parent of a sub-agent's session", () => {
    const session = parse(new CodexRolloutParser("file"), [
      codexMeta("s-child", "/work/alpha", T0, { source: { subagent: { thread_spawn: { parent_thread_id: "s-parent" } } } }),
    ]);
    expect(session.parentId).toBe("s-parent");
  });
});

describe("Agent SDK CLI session files", () => {
  it("counts a response of several lines once, with its last line's figures", () => {
    const base = { sessionId: "c-1", cwd: "/work/beta", at: T0 };
    const parser = new ClaudeProjectParser("file");
    const session = parse(parser, [
      claudeLine({ ...base, messageId: "msg-1", requestId: "req-1", output: 5 }),
      claudeLine({ ...base, at: T0 + 100, messageId: "msg-1", requestId: "req-1", output: 7, cacheRead: 100 }),
      claudeLine({ ...base, at: T0 + S, messageId: "msg-2", requestId: "req-2", input: 3, cacheWrite: 20 }),
      claudeLine({ ...base, at: T0 + 2 * S, messageId: "msg-3", requestId: "req-3", model: "<synthetic>" }),
      claudeLine({ ...base, at: T0 + 3 * S, messageId: "msg-4", requestId: "req-4", input: 0, output: 0 }),
      "{not json \"usage\"",
    ]);
    expect(session.sessionId).toBe("c-1");
    expect(session.cwd).toBe("/work/beta");
    expect(session.records.map((record) => [record.at - T0, record.input, record.output, record.cacheRead, record.cacheWrite, record.total])).toEqual([
      [0, 10, 7, 100, 0, 117],
      [S, 3, 5, 0, 20, 28],
    ]);
    expect(parser.skipped).toBe(1);
  });
});

describe("reading log lines", () => {
  it("hands on complete marked lines, drops oversized ones and leaves an unfinished last line", async () => {
    const path = join(await temp(), "log.jsonl");
    const long = (prefix: string) => `${prefix}${"x".repeat(300)}"usage"}`;
    await writeFile(path, [
      "{\"type\":\"plain\"}",
      "{\"usage\":1}",
      long("{\"type\":\"response_item\",\"payload\":\""),
      long("{\"type\":\"event_msg\",\"payload\":\""),
      "{\"usage\":2}",
      "{\"usage\":3",
    ].join("\n"));
    const lines: string[] = [];
    const skipped = await readMarkedLines(path, ["\"usage\""], (line) => lines.push(line), codexMayCarryUsage, 100);
    expect(lines).toEqual(["{\"usage\":1}", "{\"usage\":2}"]);
    expect(skipped).toBe(1);
  });

  it("joins a line across read chunks and drops one past the cap across them", async () => {
    const path = join(await temp(), "log.jsonl");
    const spanning = `{"usage":"${"a".repeat(300 * 1024)}"}`;
    const huge = `{"type":"event_msg","usage":"${"b".repeat(700 * 1024)}"}`;
    await writeFile(path, `${spanning}\n${huge}\n{"usage":4}\n`);
    const lines: string[] = [];
    const skipped = await readMarkedLines(path, ["\"usage\""], (line) => lines.push(line), codexMayCarryUsage, 512 * 1024);
    expect(lines.map((line) => line.length)).toEqual([spanning.length, 11]);
    expect(skipped).toBe(1);
  });

  it("counts an oversized Agent SDK line only when it is an assistant's", () => {
    expect(claudeMayCarryUsage("{\"parentUuid\":null,\"message\":{\"role\":\"assistant\",")).toBe(true);
    expect(claudeMayCarryUsage("{\"parentUuid\":null,\"message\":{\"role\":\"user\",")).toBe(false);
  });
});

describe("OpenCode's database", () => {
  it("reads assistant messages since a time, grouped by session, a migrated copy replacing the old row", async () => {
    const open = await openSqlite();
    if (!open) return;
    const path = join(await temp(), "opencode.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE session (id text PRIMARY KEY, project_id text, parent_id text, directory text NOT NULL, title text)");
    db.exec("CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)");
    db.exec("CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)");
    db.prepare("INSERT INTO session VALUES (?, 'p', ?, ?, 'title that is never read')").run("ses-a", null, "/work/gamma");
    db.prepare("INSERT INTO session VALUES (?, 'p', ?, ?, 'child')").run("ses-b", "ses-a", "/work/gamma");
    const assistant = (tokens: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ role: "assistant", providerID: "anthropic", modelID: "claude-haiku-4-5", cost: 0.02, tokens, time: { created: T0 + S }, ...extra });
    const insert = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    insert.run("msg-1", "ses-a", T0 + S, T0 + S, assistant({ input: 10, output: 4, reasoning: 1, cache: { read: 100, write: 5 } }));
    insert.run("msg-2", "ses-a", T0 + S, T0 + S, JSON.stringify({ role: "user", time: { created: T0 } }));
    insert.run("msg-old", "ses-a", T0 - 400 * 86_400_000, T0, assistant({ input: 10, output: 4 }, { time: { created: T0 - 400 * 86_400_000 } }));
    insert.run("msg-3", "ses-b", T0 + 2 * S, T0 + 2 * S, assistant({ input: 1, output: 1 }, { time: { created: T0 + 2 * S } }));
    db.prepare("INSERT INTO session_message VALUES (?, ?, 'assistant', 1, ?, ?, ?)").run("msg-1", "ses-a", T0 + S, T0 + S, JSON.stringify({ tokens: { input: 20, output: 4, cache: { read: 100, write: 5 } }, providerID: "anthropic", modelID: "claude-haiku-4-5", time: { created: T0 + S } }));
    db.close();

    const read = await readOpenCodeDatabase(path, T0 - 86_400_000, open, async () => undefined);
    const sessions = Object.fromEntries(read.sessions.map((session) => [session.sessionId, session]));
    expect(Object.keys(sessions).sort()).toEqual(["ses-a", "ses-b"]);
    expect(sessions["ses-a"]!.cwd).toBe("/work/gamma");
    expect(sessions["ses-b"]!.parentId).toBe("ses-a");
    expect(sessions["ses-a"]!.records.map((record) => [record.key, record.input, record.output, record.cacheRead, record.cacheWrite, record.total, record.provider, record.model])).toEqual([
      ["opencode:msg-1", 20, 4, 100, 5, 129, "anthropic", "claude-haiku-4-5"],
    ]);
    expect(sessions["ses-b"]!.records[0]!.cost).toBe(0.02);
  });

  it("says so when the database has no table it knows", async () => {
    const open = await openSqlite();
    if (!open) return;
    const path = join(await temp(), "opencode.db");
    const { DatabaseSync } = await import("node:sqlite");
    new DatabaseSync(path).close();
    expect((await readOpenCodeDatabase(path, 0, open, async () => undefined)).unsupported).toBe(true);
  });
});
