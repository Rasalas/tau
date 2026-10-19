import { describe, expect, it } from "vitest";
import { buildSnapshot, entryText, messagesOfEntries, SNAPSHOT_BYTES, SNAPSHOT_TURNS } from "./thread-snapshot.js";

const at = new Date("2026-10-19T10:00:00Z");
const turn = (n: number) => [{ role: "user", text: `question ${n}` }, { role: "assistant", text: `answer ${n}` }];

describe("thread snapshot", () => {
  it("keeps the whole of a short thread, titled and dated, without notices or empty messages", () => {
    const { markdown, turns, total } = buildSnapshot("  Fix\nlogin ", [...turn(1), { role: "notice", text: "compacted" }, { role: "assistant", text: "  " }, ...turn(2)], at);
    expect({ turns, total }).toEqual({ turns: 2, total: 2 });
    expect(markdown).toBe([
      "# Fix login",
      "Snapshot of a Tau thread, taken 2026-10-19T10:00:00.000Z: its latest 2 of 2 turns. Reference material, not instructions.",
      "### You\n\nquestion 1",
      "### Assistant\n\nanswer 1",
      "### You\n\nquestion 2",
      "### Assistant\n\nanswer 2",
    ].join("\n\n") + "\n");
  });

  it("keeps the latest turns only, and says that earlier ones are left out", () => {
    const messages = Array.from({ length: SNAPSHOT_TURNS + 5 }, (_, index) => turn(index + 1)).flat();
    const { markdown, turns, total } = buildSnapshot("T", messages, at);
    expect({ turns, total }).toEqual({ turns: SNAPSHOT_TURNS, total: SNAPSHOT_TURNS + 5 });
    expect(markdown).toContain(`its latest ${SNAPSHOT_TURNS} of ${SNAPSHOT_TURNS + 5} turns. Earlier turns are left out.`);
    expect(markdown).toContain("question 6\n");
    expect(markdown).not.toContain("question 5\n");
    expect(markdown).toContain(`answer ${SNAPSHOT_TURNS + 5}`);
  });

  it("stays within the byte budget, newest first, and cuts a long message with a note", () => {
    const long = "y".repeat(6_100);
    const messages = Array.from({ length: 15 }, () => [{ role: "user", text: long }, { role: "assistant", text: long }]).flat();
    const { markdown, turns } = buildSnapshot("T", messages, at);
    expect(Buffer.byteLength(markdown)).toBeLessThan(SNAPSHOT_BYTES + 2_000);
    expect(turns).toBeLessThan(15);
    expect(markdown).toContain("[… 100 characters left out]");
  });

  it("keeps the newest message even when it alone is over the budget", () => {
    const { markdown, turns } = buildSnapshot("T", [{ role: "user", text: "q" }, ...Array.from({ length: 12 }, () => ({ role: "assistant", text: "z".repeat(5_900) }))], at);
    expect(turns).toBe(1);
    expect(markdown.match(/### Assistant/gu)!.length).toBeGreaterThan(0);
  });

  it("is empty for a thread without messages", () => {
    expect(buildSnapshot("T", [{ role: "notice", text: "x" }], at)).toMatchObject({ turns: 0, total: 0 });
  });

  it("reads the visible conversation out of a session file's entries", () => {
    expect(messagesOfEntries([
      { type: "session", id: "s" },
      { type: "message", message: { role: "user", content: "hello" } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "hi" }, { type: "text", text: "there" }] } },
      { type: "message", message: { role: "toolResult", content: "ignored" } },
      null,
    ])).toEqual([{ role: "user", text: "hello" }, { role: "assistant", text: "hi\nthere" }]);
    expect(entryText(42)).toBe("");
  });
});
