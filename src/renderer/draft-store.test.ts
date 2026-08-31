// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { draftKey, readComposerDraft, readNewThreadDraft, writeComposerDraft, writeNewThreadDraft } from "./draft-store";

beforeEach(() => localStorage.clear());

describe("composer drafts", () => {
  it("persists text independently for sessions and unstarted project threads", () => {
    writeComposerDraft(localStorage, draftKey("one"), "session text");
    const pending = { projectPath: "/repos/tau", projectName: "tau" };
    writeNewThreadDraft(localStorage, pending);
    writeComposerDraft(localStorage, draftKey(undefined, pending), "new thread text");

    expect(readComposerDraft(localStorage, draftKey("one"))).toBe("session text");
    expect(readComposerDraft(localStorage, draftKey(undefined, pending))).toBe("new thread text");
    expect(readNewThreadDraft(localStorage)).toEqual(pending);
  });
});
