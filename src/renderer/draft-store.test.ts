// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { draftKey, readNewThreadDraft, writeNewThreadDraft } from "./draft-store";

beforeEach(() => localStorage.clear());

describe("composer drafts", () => {
  it("persists the active unstarted project thread", () => {
    const pending = { projectPath: "/repos/tau", projectName: "tau" };
    writeNewThreadDraft(localStorage, pending);

    expect(readNewThreadDraft(localStorage)).toEqual(pending);
  });

  it("keeps same-project new-thread drafts in distinct scopes", () => {
    const first = { projectPath: "/repos/tau", projectName: "tau", draftId: "request-1" };
    const second = { projectPath: "/repos/tau", projectName: "tau", draftId: "request-2" };
    expect(draftKey(undefined, first)).not.toBe(draftKey(undefined, second));
  });
});
