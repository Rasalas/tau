import { describe, expect, it } from "vitest";
import type { UiMessage } from "./contracts.js";
import { estimateTranscriptTokens, TranscriptMessageIndex } from "./transcript-index.js";

const message = (id: string, text = id): UiMessage => ({
  id,
  role: "assistant",
  text,
  timestamp: 1,
});

describe("TranscriptMessageIndex", () => {
  it("updates streamed records by ID while preserving settled references", () => {
    const settled = message("settled");
    const active = message("active", "a");
    const index = new TranscriptMessageIndex([settled, active]);
    const snapshot = index.messages;

    const next = index.updateMany(new Map([
      ["active", (record) => ({ ...record, text: `${record.text}b` })],
    ]));

    expect(next).toEqual([settled, { ...active, text: "ab" }]);
    expect(next).toBe(snapshot);
    expect(next[0]).toBe(settled);
    expect(index.indexOf("active")).toBe(1);
  });

  it("rebuilds positions only for structural transcript changes", () => {
    const index = new TranscriptMessageIndex([message("one"), message("two")]);
    index.append(message("three"));
    expect(index.indexOf("three")).toBe(2);
    index.prepend([message("zero")]);
    expect(index.indexOf("one")).toBe(1);
    index.remove("two");
    expect(index.indexOf("three")).toBe(2);
  });

  it("updates token and user revisions incrementally for stream deltas", () => {
    const user: UiMessage = { id: "user", role: "user", text: "prompt", timestamp: 1 };
    const active = message("active", "answer");
    const index = new TranscriptMessageIndex([user, active]);
    const initialTokens = estimateTranscriptTokens(user) + estimateTranscriptTokens(active);
    const initialRevision = index.userRevision;

    index.update("active", (record) => ({ ...record, text: `${record.text} more` }));

    expect(index.tokenEstimate).toBe(initialTokens + estimateTranscriptTokens({ ...active, text: "answer more" }) - estimateTranscriptTokens(active));
    expect(index.userRevision).toBe(initialRevision);

    index.append({ id: "next-user", role: "user", text: "next", timestamp: 3 });
    expect(index.userRevision).toBe(initialRevision + 1);
  });

  it("increments lookup revision when an existing user record gains identity metadata", () => {
    const prompt: UiMessage = { id: "same-id", role: "user", text: "same prompt", timestamp: 1 };
    const index = new TranscriptMessageIndex([prompt, message("answer", "answer")]);
    const initialLookupRevision = index.lookupRevision;

    index.update("answer", (record) => ({ ...record, text: `${record.text} delta` }));
    expect(index.lookupRevision).toBe(initialLookupRevision);

    index.update("same-id", (record) => ({
      ...record,
      clientTurnId: "authoritative-turn",
      clientMessageId: "authoritative-message",
    }));
    expect(index.lookupRevision).toBe(initialLookupRevision + 1);
  });
});
