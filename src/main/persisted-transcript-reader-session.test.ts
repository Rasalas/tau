import { parseSessionEntries, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { readPersistedSessionBranch } from "./persisted-transcript-reader-session.js";

const header = { type: "session", version: 3, id: "thread", cwd: "/repo", timestamp: new Date(0).toISOString() };
const messageEntry = (id: string, parentId: string | null, text: string) => ({ type: "message", id, parentId, timestamp: new Date(1).toISOString(), message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
const encode = (entries: unknown[]) => entries.map((value) => JSON.stringify(value)).join("\n") + "\n";
const sdkBranch = (text: string) => SessionManager.inMemory("/repo", undefined, parseSessionEntries(text)).getBranch();

/** Legacy v1 migration chooses fresh ids. Compare their positions and ancestry, not the random bytes. */
function normalize(branch: readonly unknown[]) {
  const entries = branch as Array<Record<string, unknown>>;
  const ids = new Map(entries.map((entry, index) => [entry.id, index]));
  return entries.map((entry) => ({ ...entry, id: ids.get(entry.id),
    parentId: entry.parentId ? ids.get(entry.parentId) ?? entry.parentId : null,
    ...(entry.firstKeptEntryId ? { firstKeptEntryId: ids.get(entry.firstKeptEntryId) ?? entry.firstKeptEntryId } : {}),
  }));
}

describe("read-only Pi branch selection", () => {
  it.each([
    [header],
    [header, messageEntry("root", null, "root"), messageEntry("discarded", "root", "old branch"), messageEntry("selected", "root", "new branch")],
    [header, messageEntry("root", null, "root"), messageEntry("missing-parent", "absent", "orphan")],
    [header, messageEntry("root", null, "root"), messageEntry("duplicate", "root", "old duplicate"), messageEntry("duplicate", "root", "last duplicate")],
    [header, messageEntry("root", null, "root"), { type: "custom", id: "marker", parentId: "root", customType: "tau", data: { retained: true } }],
    [header, messageEntry("root", null, "root"), { type: "compaction", id: "compact", parentId: "root", firstKeptEntryId: "root", summary: "summary", tokensBefore: 42 }],
  ])("matches the SDK's leaf/index/ancestor semantics for %j", (...entries) => {
    const text = encode(entries);
    expect(readPersistedSessionBranch(text)).toEqual(sdkBranch(text));
  });

  it("uses Pi's legacy migrations, including hook messages and compaction entry references", () => {
    const text = encode([
      { ...header, version: 1 },
      { type: "message", message: { role: "user", content: "legacy user", timestamp: 1 } },
      { type: "message", message: { role: "hookMessage", content: "legacy notice", timestamp: 2 } },
      { type: "compaction", firstKeptEntryIndex: 1, summary: "summary", tokensBefore: 20 },
    ]);
    const actual = readPersistedSessionBranch(text);
    expect(normalize(actual)).toEqual(normalize(sdkBranch(text)));
    expect((actual[1] as { message: { role: string } }).message.role).toBe("custom");
  });

  it("skips malformed JSON lines and keeps a final line without a newline, like Pi", () => {
    const text = `${JSON.stringify(header)}\nmalformed\n\n${JSON.stringify(messageEntry("leaf", null, "retained"))}`;
    expect(readPersistedSessionBranch(text)).toEqual(sdkBranch(text));
  });

  it("refuses invalid headers and cyclic branches without modifying any file", () => {
    expect(() => readPersistedSessionBranch(encode([messageEntry("leaf", null, "no header")]))).toThrow("Invalid Pi session header");
    expect(() => readPersistedSessionBranch(encode([header, messageEntry("cycle", "cycle", "cycle")]))).toThrow("contains a cycle");
  });
});
