// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { STORAGE_KEYS } from "./storage-keys";
import { createMemoryStorage } from "./client-storage";
import { createNewThreadDraft, draftKey, readComposerDraft, readComposerDraftState, readNewThreadDraft, writeComposerDraft, writeComposerDraftState, writeNewThreadDraft } from "./draft-store";

describe("composer drafts", () => {
  it("migrates the legacy collection once and writes only the changed draft", () => {
    const storage = createMemoryStorage();
    storage.set(STORAGE_KEYS.composerDrafts, JSON.stringify({ "session:one": "old", "session:two": "keep" }));
    expect(readComposerDraft(storage, "session:one")).toBe("old");
    expect(storage.get(STORAGE_KEYS.composerDrafts)).toBeNull();
    const writes: string[] = [];
    const set = storage.set;
    storage.set = (key, value) => { writes.push(key); set(key, value); };
    writeComposerDraft(storage, "session:one", "new");
    expect(writes).toHaveLength(1);
    expect(readComposerDraft(storage, "session:two")).toBe("keep");
  });

  it("reads legacy text when migration writes fail and keeps the source record", () => {
    const storage = createMemoryStorage();
    storage.set(STORAGE_KEYS.composerDrafts, JSON.stringify({ "session:one": "recoverable" }));
    storage.set = () => { throw new Error("quota"); };
    expect(readComposerDraft(storage, "session:one")).toBe("recoverable");
    expect(storage.get(STORAGE_KEYS.composerDrafts)).not.toBeNull();
    storage.get = () => { throw new Error("privacy"); };
    expect(readComposerDraft(storage, "session:one")).toBe("");
  });

  it("persists text independently for sessions and unstarted project threads", () => {
    const storage = createMemoryStorage();
    writeComposerDraft(storage, draftKey("one"), "session text");
    const pending = createNewThreadDraft({ projectPath: "/repos/tau", projectName: "tau" });
    writeNewThreadDraft(storage, pending);
    writeComposerDraft(storage, draftKey(undefined, pending), "new thread text");

    expect(readComposerDraft(storage, draftKey("one"))).toBe("session text");
    expect(readComposerDraft(storage, draftKey(undefined, pending))).toBe("new thread text");
    expect(readNewThreadDraft(storage)).toEqual({ ...pending, draft: "new thread text" });
  });

  it("keeps an extension's state beside the text, per draft and per extension, and drops it on undefined", () => {
    const storage = createMemoryStorage();
    const session = draftKey("one");
    writeComposerDraft(storage, session, "text");
    writeComposerDraftState(storage, session, "acme.chips", [{ id: "c1", kind: "file" }]);
    writeComposerDraftState(storage, session, "acme.other", { n: 1 });
    expect(readComposerDraftState(storage, session, "acme.chips")).toEqual([{ id: "c1", kind: "file" }]);
    expect(readComposerDraftState(storage, draftKey("two"), "acme.chips")).toBeUndefined();
    expect(readComposerDraft(storage, session)).toBe("text");

    const pending = createNewThreadDraft({ projectPath: "/repos/tau", projectName: "tau" });
    writeNewThreadDraft(storage, pending);
    const fresh = draftKey(undefined, pending);
    writeComposerDraft(storage, fresh, "hello");
    writeComposerDraftState(storage, fresh, "acme.chips", ["x"]);
    // The text and the state of a pending draft survive one another's writes.
    writeComposerDraft(storage, fresh, "hello again");
    expect(readComposerDraftState(storage, fresh, "acme.chips")).toEqual(["x"]);
    expect(readNewThreadDraft(storage)?.draft).toBe("hello again");

    writeComposerDraftState(storage, fresh, "acme.chips", undefined);
    writeComposerDraftState(storage, session, "acme.chips", undefined);
    expect(readNewThreadDraft(storage)?.extensions).toBeUndefined();
    expect(readComposerDraftState(storage, session, "acme.chips")).toBeUndefined();
    expect(readComposerDraftState(storage, session, "acme.other")).toEqual({ n: 1 });
  });

  it("persists an explicit model choice with the unstarted thread", () => {
    const storage = createMemoryStorage();
    const pending = {
      ...createNewThreadDraft({ projectPath: "/repos/tau", projectName: "tau" }),
      model: { provider: "openai-codex", id: "gpt-6-astra", name: "GPT-6 Astra" },
    };

    writeNewThreadDraft(storage, pending);

    expect(readNewThreadDraft(storage)?.model).toEqual(pending.model);
  });

  it("gives every draft instance its own scope, including the same project", () => {
    const first = createNewThreadDraft({ projectPath: "/repos/tau", projectName: "tau" });
    const second = createNewThreadDraft({ projectPath: "/repos/tau", projectName: "tau" });
    expect(first.kind).toBe("draft");
    expect(first.draftId).not.toBe(second.draftId);
    expect(draftKey(undefined, first)).not.toBe(draftKey(undefined, second));
  });

  it("migrates a legacy persisted draft to a stable discriminated scope", () => {
    const storage = createMemoryStorage();
    storage.set("tau.active-new-thread.v1", JSON.stringify({ projectPath: "/repos/tau", projectName: "tau" }));
    const first = readNewThreadDraft(storage);
    const second = readNewThreadDraft(storage);
    expect(first).toMatchObject({ kind: "draft", projectPath: "/repos/tau" });
    expect(second?.draftId).toBe(first?.draftId);
  });
});
