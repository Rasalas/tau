import { describe, expect, it } from "vitest";
import { branchRecords } from "./thread-projection.js";
import { mapMessage } from "./host-messages.js";

let clock = Date.parse("2026-09-28T10:00:00Z");
function branch(): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  const push = (entry: Record<string, unknown>) => {
    const id = `e${entries.length + 1}`;
    entries.push({ id, parentId: entries.at(-1)?.id ?? null, timestamp: new Date(clock += 1_000).toISOString(), ...entry });
    return id;
  };
  const turn = (text: string) => {
    const user = push({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: clock } });
    push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `${text} done `.repeat(40) }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 }, stopReason: "stop", timestamp: clock } });
    return user;
  };
  turn("one"); turn("two"); turn("three");
  const fourth = turn("four");
  push({ type: "compaction", summary: "## Goal\nFix it.", firstKeptEntryId: fourth, tokensBefore: 142_000 });
  const sixth = (turn("five"), turn("six"));
  push({ type: "compaction", summary: "## Goal\nStill fixing.", firstKeptEntryId: sixth, tokensBefore: 90_000 });
  turn("seven");
  return entries;
}

describe("compaction records", () => {
  it("puts a divider where each compaction happened, with the turns it summarised and the sizes", () => {
    const entries = branch();
    const rows = branchRecords(entries, []).map(({ record }, index) => mapMessage(record, index)!);
    const dividers = rows.filter((row) => row.compaction);
    expect(rows.map((row) => row.role === "notice" ? "|" : row.role[0]).join("")).toBe("uauauaua|uaua|ua");
    expect(dividers[0]).toMatchObject({ id: "e9", sourceEntryId: "e9", role: "notice", text: "Context compacted" });
    expect(dividers[0]!.compaction).toMatchObject({ tokensBefore: 142_000, turns: { first: 1, last: 3 }, summary: "## Goal\nFix it." });
    // The summary and the kept fourth turn, estimated.
    expect(dividers[0]!.compaction!.tokensAfter).toBeGreaterThan(50);
    expect(dividers[0]!.compaction!.tokensAfter).toBeLessThan(200);
    expect(dividers[1]!.compaction).toMatchObject({ tokensBefore: 90_000, turns: { first: 4, last: 5 } });
  });
});
