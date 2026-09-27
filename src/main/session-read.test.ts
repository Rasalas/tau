import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionHeldElsewhereError, SessionLocks } from "./session-locks.js";
import { openRecentSession, piRewritesOnOpen, readSessionFile } from "./session-read.js";

const timestamp = "2026-09-27T00:00:00.000Z";
const header = (id: string, cwd: string, version = 3) => JSON.stringify({ type: "session", version, id, timestamp, cwd });
const message = (id: string, parentId: string | null, role: string, text: string) =>
  JSON.stringify({ type: "message", id, parentId, timestamp, message: { role, content: [{ type: "text", text }], timestamp: 1 } });

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tau-session-read-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function file(name: string, text: string, mtimeSeconds?: number): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  if (mtimeSeconds !== undefined) utimesSync(path, mtimeSeconds, mtimeSeconds);
  return path;
}

describe("reading a Pi session", () => {
  const cases: Array<[string, string]> = [
    ["an older format", `${header("a", "/p", 2)}\n${message("e1", null, "hookMessage", "x")}\n`],
    ["a last line without its newline", `${header("b", "/p")}\n${message("e1", null, "user", "x")}`],
    ["an empty file", ""],
  ];

  it.each(cases)("knows Pi's open would write %s", (_name, text) => {
    expect(piRewritesOnOpen(file("s.jsonl", text))).toBe(true);
  });

  it("knows Pi's open leaves a current, complete file alone", () => {
    const path = file("s.jsonl", `${header("c", "/p")}\n${message("e1", null, "user", "x")}\n`);
    expect(piRewritesOnOpen(path)).toBe(false);
    const before = readFileSync(path, "utf8");
    SessionManager.open(path);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("migrates in memory and never writes the file", () => {
    const text = `${header("a", "/p", 2)}\n${message("e1", null, "hookMessage", "x")}`;
    const path = file("s.jsonl", text);
    const manager = readSessionFile(path);

    expect(manager.getSessionId()).toBe("a");
    expect(manager.getCwd()).toBe("/p");
    expect(manager.getBranch()).toMatchObject([{ id: "e1", message: { role: "custom" } }]);
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  it("refuses a file that is no session, as Pi does", () => {
    expect(() => readSessionFile(file("s.jsonl", `${message("e1", null, "user", "x")}\n`))).toThrow(/not a valid Pi session/u);
  });
});

describe("opening the newest session of a folder", () => {
  it("picks the newest session of that folder in a shared sessions folder", async () => {
    const project = join(dir, "project");
    file("old.jsonl", `${header("old", project)}\n`, 1_000);
    file("new.jsonl", `${header("new", project)}\n`, 2_000);
    file("other.jsonl", `${header("other", join(dir, "elsewhere"))}\n`, 3_000);
    file("broken.jsonl", "not json\n", 4_000);

    const manager = await openRecentSession(new SessionLocks(), project, dir);
    expect(manager.getSessionId()).toBe("new");
    expect(manager.getCwd()).toBe(project);
  });

  it("starts a new session when the folder has none, and refuses one another process holds", async () => {
    const project = join(dir, "project");
    const fresh = await openRecentSession(new SessionLocks(), project, dir);
    expect(fresh.getSessionFile()?.startsWith(dir)).toBe(true);
    expect(fresh.getBranch()).toEqual([]);

    const path = file("held.jsonl", `${header("held", project, 2)}\n`);
    const other = new SessionLocks({ dataFolder: "/data/window" });
    await other.acquire(path);
    await expect(openRecentSession(new SessionLocks(), project, dir)).rejects.toThrow(SessionHeldElsewhereError);
    expect(readFileSync(path, "utf8")).toBe(`${header("held", project, 2)}\n`);
    other.releaseAll();
  });
});
