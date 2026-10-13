import { describe, expect, it } from "vitest";
import type { UiMessage } from "../shared/contracts";
import { appendMessage, appendMessageDelta, collapseRetriedErrors, EMPTY_TRANSCRIPT, removeMessage, replaceMessage, replaceTranscript } from "./transcript-state";

const user = (id: string): UiMessage => ({ id, role: "user", text: "go", timestamp: 0 });
const failed = (id: string, error: string, timestamp = 1): UiMessage => ({ id, role: "assistant", text: "", error, timestamp });
const answer = (id: string, text = "ok"): UiMessage => ({ id, role: "assistant", text, timestamp: 9 });

describe("activity revision", () => {
  it("ignores text and thinking growth after the first visible answer", () => {
    const initial = replaceTranscript(EMPTY_TRANSCRIPT, [user("u"), answer("a", " \n")]);
    const thinking = appendMessageDelta(initial, "a", "thinking", "reasoning");
    expect(thinking.activityRevision).toBe(initial.activityRevision);
    const visible = appendMessageDelta(thinking, "a", "text", "Answer");
    expect(visible.activityRevision).toBe(initial.activityRevision + 1);
    const longer = appendMessageDelta(visible, "a", "text", " grows");
    expect(longer.messages).not.toBe(visible.messages);
    expect(longer.activityRevision).toBe(visible.activityRevision);
    expect(longer.revision).toBeGreaterThan(visible.revision);
  });

  it.each<Partial<UiMessage>>([
    { id: "new-id" }, { role: "user" }, { timestamp: 10 }, { sourceEntryId: "entry" }, { text: " \n" },
  ])("invalidates placement for changed message fields %j", (fields) => {
    const initial = replaceTranscript(EMPTY_TRANSCRIPT, [answer("a")]);
    expect(replaceMessage(initial, "a", { ...answer("a"), ...fields }).activityRevision).toBe(initial.activityRevision + 1);
  });

  it("invalidates placement when rows arrive, disappear or history is replaced", () => {
    const initial = replaceTranscript(EMPTY_TRANSCRIPT, [user("u")]);
    const appended = appendMessage(initial, answer("a"));
    expect(appended.activityRevision).toBe(initial.activityRevision + 1);
    expect(removeMessage(appended, "a").activityRevision).toBe(appended.activityRevision + 1);
    expect(replaceTranscript(appended, [user("older"), ...appended.messages]).activityRevision).toBe(appended.activityRevision + 1);
  });
});

describe("collapseRetriedErrors", () => {
  it("makes a run of failed answers one row that counts the retries and keeps the newest reason", () => {
    const messages = [user("u1"), failed("a1", "500 · first", 1), failed("a2", "500 · second", 2), failed("a3", "500 · third", 3), failed("a4", "500 · last", 4)];
    const { messages: rows, retried } = collapseRetriedErrors(messages);
    expect(rows.map((row) => row.id)).toEqual(["u1", "a1"]);
    expect(rows[1]).toMatchObject({ id: "a1", error: "500 · last", timestamp: 4 });
    expect(retried.get("a1")).toEqual({ retries: 3, recovered: false });
  });

  it("marks a run the next answer recovered from", () => {
    const { messages: rows, retried } = collapseRetriedErrors([user("u1"), failed("a1", "x"), failed("a2", "y"), answer("a3")]);
    expect(rows.map((row) => row.id)).toEqual(["u1", "a1", "a3"]);
    expect(retried.get("a1")).toEqual({ retries: 1, recovered: true });
  });

  it("leaves single failures, failures with text and separate turns alone", () => {
    const messages = [user("u1"), failed("a1", "x"), user("u2"), failed("a2", "y"), { ...failed("a3", "terminated"), text: "…" }, failed("a4", "terminated")];
    const { messages: rows, retried } = collapseRetriedErrors(messages);
    expect(rows.map((row) => row.id)).toEqual(["u1", "a1", "u2", "a2", "a3", "a4"]);
    expect(retried.size).toBe(0);
    expect(collapseRetriedErrors(messages).messages).toBe(messages);
  });
});
