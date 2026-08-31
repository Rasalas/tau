// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  ComposerScopeStore,
  createDraftKey,
} from "./composer-scope-store";

describe("ComposerScopeStore", () => {
  it("does not let an older rejected submission hide a newer attachment error", () => {
    const store = new ComposerScopeStore();
    const key = createDraftKey("thread:errors");
    store.setDraft(key, "send this");
    const submission = store.beginSubmission(key);
    if (!("settle" in submission)) throw new Error("expected a submission handle");
    const generation = store.setAttachmentProcessing(key, Promise.resolve());
    store.setAttachmentError(key, "The dropped file is not supported.", generation);
    submission.settle({ accepted: false, message: "The prompt was rejected." });
    expect(store.getSnapshot(key).error).toBe("The dropped file is not supported.");
  });

  it("keeps a submission rejection when a later attachment operation succeeds", () => {
    const store = new ComposerScopeStore();
    const key = createDraftKey("thread:submission-error");
    store.setDraft(key, "send this");
    const submission = store.beginSubmission(key);
    if (!("settle" in submission)) throw new Error("expected a submission handle");
    store.setAttachmentProcessing(key, Promise.resolve());
    store.setAttachments(key, [{
      id: 2, kind: "image", name: "new.png", mimeType: "image/png", data: "aA==", size: 1,
      previewUrl: "data:image/png;base64,aA==",
    }]);

    submission.settle({ accepted: false, message: "The prompt was rejected." });
    store.setAttachmentError(key, undefined, store.getAttachmentGeneration(key));

    expect(store.getSnapshot(key)).toMatchObject({
      error: "The prompt was rejected.",
      attachments: [{ name: "new.png" }],
    });
  });

  it("moves a correlated draft without losing attachments", () => {
    const store = new ComposerScopeStore();
    const from = createDraftKey("new:/project:request-1");
    const to = createDraftKey("session:created");
    store.setDraft(from, "keep edits");
    store.setAttachments(from, [{
      id: 10, kind: "image", name: "keep.png", mimeType: "image/png", data: "aA==", size: 1,
      previewUrl: "data:image/png;base64,aA==",
    }]);
    store.moveScope(from, to);
    expect(store.getSnapshot(to)).toMatchObject({ draft: "keep edits", attachments: [{ name: "keep.png" }] });
    expect(store.getSnapshot(from)).toMatchObject({ draft: "", attachments: [] });
  });

  it("moves an in-flight submission with its scope before settling", () => {
    const store = new ComposerScopeStore();
    const from = createDraftKey("new:/project:request-2");
    const to = createDraftKey("session:created-2");
    store.setDraft(from, "sent before handoff");
    const submission = store.beginSubmission(from);
    if (!("settle" in submission)) throw new Error("expected a submission handle");

    store.setDraft(from, "edited while sending");
    store.moveScope(from, to);
    expect(store.getSnapshot(to)).toMatchObject({ draft: "edited while sending", submissionPending: true });

    submission.settle({ accepted: true });
    expect(store.getSnapshot(to)).toMatchObject({ draft: "edited while sending", submissionPending: false });
    const next = store.beginSubmission(to);
    expect("settle" in next).toBe(true);
  });

});
