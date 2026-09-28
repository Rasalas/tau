import { describe, expect, it } from "vitest";
import type { UiMessage } from "../shared/contracts";
import { collapseRetriedErrors } from "./transcript-state";

const user = (id: string): UiMessage => ({ id, role: "user", text: "go", timestamp: 0 });
const failed = (id: string, error: string, timestamp = 1): UiMessage => ({ id, role: "assistant", text: "", error, timestamp });
const answer = (id: string, text = "ok"): UiMessage => ({ id, role: "assistant", text, timestamp: 9 });

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
