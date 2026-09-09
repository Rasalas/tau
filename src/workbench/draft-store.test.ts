// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "./client-storage";
import { createNewThreadDraft, draftKey, readComposerDraft, readNewThreadDraft, writeComposerDraft, writeNewThreadDraft } from "./draft-store";

describe("composer drafts", () => {
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
