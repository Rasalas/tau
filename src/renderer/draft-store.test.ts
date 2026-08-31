// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createNewThreadDraft, draftKey, readComposerDraft, readNewThreadDraft, writeComposerDraft, writeNewThreadDraft } from "./draft-store";

beforeEach(() => localStorage.clear());

describe("composer drafts", () => {
  it("persists text independently for sessions and unstarted project threads", () => {
    writeComposerDraft(localStorage, draftKey("one"), "session text");
    const pending = createNewThreadDraft({ projectPath: "/repos/tau", projectName: "tau" });
    writeNewThreadDraft(localStorage, pending);
    writeComposerDraft(localStorage, draftKey(undefined, pending), "new thread text");

    expect(readComposerDraft(localStorage, draftKey("one"))).toBe("session text");
    expect(readComposerDraft(localStorage, draftKey(undefined, pending))).toBe("new thread text");
    expect(readNewThreadDraft(localStorage)).toEqual({ ...pending, draft: "new thread text" });
  });

  it("gives every draft instance its own scope, including the same project", () => {
    const first = createNewThreadDraft({ projectPath: "/repos/tau", projectName: "tau" });
    const second = createNewThreadDraft({ projectPath: "/repos/tau", projectName: "tau" });
    expect(first.kind).toBe("draft");
    expect(first.draftId).not.toBe(second.draftId);
    expect(draftKey(undefined, first)).not.toBe(draftKey(undefined, second));
  });

  it("migrates a legacy persisted draft to a stable discriminated scope", () => {
    localStorage.setItem("tau.active-new-thread.v1", JSON.stringify({ projectPath: "/repos/tau", projectName: "tau" }));
    const first = readNewThreadDraft(localStorage);
    const second = readNewThreadDraft(localStorage);
    expect(first).toMatchObject({ kind: "draft", projectPath: "/repos/tau" });
    expect(second?.draftId).toBe(first?.draftId);
  });
});
