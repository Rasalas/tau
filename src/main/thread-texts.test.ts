import { describe, expect, it } from "vitest";
import { THREAD_TEXT_CHARS, threadTextsDelta } from "./thread-texts";

const record = (id: string, updatedAt: number, texts: Array<[string, string]> = [["user", `about ${id}`]]) => ({
  tauThreadId: id, updatedAt, messages: texts.map(([role, text]) => ({ role, text })),
});

describe("threadTextsDelta", () => {
  it("answers with the threads the caller lacks or holds older, newest first, and names the ones gone", () => {
    const records = [record("a", 10), record("b", 30), record("c", 20)];
    const answer = threadTextsDelta(records, { known: { a: 10, c: 5, gone: 1 } });
    expect(answer.threads.map((thread) => thread.threadId)).toEqual(["b", "c"]);
    expect(answer.removed).toEqual(["gone"]);
    expect(answer.more).toBe(false);
  });

  it("hands out at most `limit` threads and says more are waiting", () => {
    const records = Array.from({ length: 5 }, (_, index) => record(`t${index}`, index));
    const first = threadTextsDelta(records, { limit: 2 });
    expect(first.threads.map((thread) => thread.threadId)).toEqual(["t4", "t3"]);
    expect(first.more).toBe(true);
    const known = Object.fromEntries(first.threads.map((thread) => [thread.threadId, thread.updatedAt]));
    expect(threadTextsDelta(records, { known, limit: 2 }).threads.map((thread) => thread.threadId)).toEqual(["t2", "t1"]);
  });

  it("keeps only user and assistant text, and the start of a long thread", () => {
    const long = "x".repeat(THREAD_TEXT_CHARS - 9);
    const [thread] = threadTextsDelta([record("a", 1, [["user", "hi"], ["toolResult", "ignored"], ["assistant", "  "], ["assistant", long], ["user", "the end of it"]])], {}).threads;
    expect(thread!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(thread!.messages.at(-1)!.text).toBe("the end");
  });

  it("reads garbage input as an empty request", () => {
    expect(threadTextsDelta([record("a", 1)], "nonsense").threads).toHaveLength(1);
    expect(threadTextsDelta([record("a", 1)], { known: { a: "1" }, limit: -3 }).threads).toHaveLength(1);
  });
});
