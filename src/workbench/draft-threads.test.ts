import { describe, expect, it } from "vitest";
import { createMemoryStorage, type ClientStorage } from "./client-storage";
import { ComposerScopeStore, createDraftKey } from "./composer-scope-store";
import { createNewThreadDraft, draftKey, writeComposerDraft, writeNewThreadDraft, type NewThreadDraft } from "./draft-store";
import { DraftThreads, type DraftThread } from "./draft-threads";
import { NewThreadController } from "./new-thread-controller";
import { ThreadStore } from "./thread-store";

function setup(storage: ClientStorage = createMemoryStorage()) {
  const scopes = new ComposerScopeStore();
  const newThread = new NewThreadController(storage);
  let published: readonly DraftThread[] = [];
  const threads = new ThreadStore();
  const drafts = new DraftThreads({ storage, scopes, newThread, publish: (rows) => { published = rows; }, threads: {
    listed: (id) => (threads.getThread(id)?.messageCount ?? 0) > 0,
    active: (id) => threads.getSnapshot().activeThreadId === id,
    subscribe: threads.subscribe,
  } });
  /** What the composer does when the user types into the draft on screen. */
  const type = (draft: NewThreadDraft, text: string) => {
    const scope = createDraftKey(draftKey(undefined, draft));
    scopes.setDraft(scope, text);
    writeComposerDraft(storage, scope, text);
  };
  /** What navigation does when the draft on screen is left. */
  const leave = () => {
    const current = newThread.current();
    if (current) drafts.keep(current);
    newThread.set(undefined);
    writeNewThreadDraft(storage);
  };
  return { storage, scopes, threads, newThread, drafts, rows: () => published, type, leave };
}

const project = { projectPath: "/repos/tau", projectName: "tau" };

describe("draft rows", () => {
  it("keeps a submitted thread visible when navigation leaves before worktree creation", async () => {
    const { scopes, newThread, drafts, rows, type, leave } = setup();
    const draft = createNewThreadDraft(project);
    newThread.begin(draft);
    type(draft, "Fix the disappearing threads");
    const handle = await scopes.beginSubmission(createDraftKey(draftKey(undefined, draft)));
    leave();
    expect(rows()).toMatchObject([{ draftId: draft.draftId, preview: "Fix the disappearing threads", active: false }]);
    newThread.begin(createNewThreadDraft(project));
    drafts.handoff(draft.draftId, "created");
    expect(rows()).toEqual(expect.arrayContaining([expect.objectContaining({ draftId: draft.draftId, sessionId: "created", active: false })]));
    if ("settle" in handle) handle.settle({ accepted: true });
  });

  it("restores a detached failed setup as a persisted draft", async () => {
    const { storage, scopes, newThread, drafts, rows, type, leave } = setup();
    const draft = createNewThreadDraft(project);
    newThread.begin(draft);
    type(draft, "Keep the failed prompt");
    const handle = await scopes.beginSubmission(createDraftKey(draftKey(undefined, draft)));
    leave();
    if ("settle" in handle) handle.settle({ accepted: false, message: "setup failed" });
    expect(rows()).toMatchObject([{ draftId: draft.draftId, preview: "Keep the failed prompt", active: false }]);
    expect(rows()[0]?.submitting).toBeUndefined();
    expect(drafts.find(draft.draftId)).toBeDefined();
    expect(setup(storage).rows()).toMatchObject([{ draftId: draft.draftId, preview: "Keep the failed prompt" }]);
    const retry = await scopes.beginSubmission(createDraftKey(draftKey(undefined, draft)));
    newThread.set(undefined);
    drafts.handoff(draft.draftId, "retried");
    if ("settle" in retry) retry.settle({ accepted: true });
    expect(rows()).toMatchObject([{ draftId: draft.draftId, sessionId: "retried" }]);
    expect(setup(storage).drafts.find(draft.draftId)).toBeUndefined();
  });

  it("shows a new thread's draft from the moment it opens, titled by its first line as it is typed", () => {
    const { newThread, rows, type } = setup();
    const draft = createNewThreadDraft(project);
    newThread.begin(draft);
    expect(rows()).toMatchObject([{ draftId: draft.draftId, projectName: "tau", preview: "", attachments: 0, active: true }]);

    type(draft, "\n  Fix the login bug\nwith details");
    expect(rows()[0]?.preview).toBe("Fix the login bug");
  });

  it("drops a draft left empty, and keeps one left with text until it is opened again", () => {
    const { storage, newThread, drafts, rows, type, leave } = setup();
    const empty = createNewThreadDraft(project);
    newThread.begin(empty);
    leave();
    expect(rows()).toEqual([]);

    const written = createNewThreadDraft(project);
    newThread.begin(written);
    type(written, "Keep me");
    leave();
    expect(rows()).toMatchObject([{ draftId: written.draftId, preview: "Keep me", active: false }]);

    // It outlives the window.
    const again = setup(storage);
    expect(again.rows()).toMatchObject([{ draftId: written.draftId, preview: "Keep me", active: false }]);

    const taken = drafts.take(written.draftId);
    expect(taken).toMatchObject({ draftId: written.draftId, draft: "Keep me" });
    newThread.begin(taken!);
    expect(rows()).toMatchObject([{ draftId: written.draftId, preview: "Keep me", active: true }]);
    expect(setup(storage).rows()).toMatchObject([{ draftId: written.draftId, active: true }]);
  });

  it("keeps a draft whose composer holds only images, for as long as the window lives", () => {
    const { storage, scopes, newThread, rows, leave } = setup();
    const draft = createNewThreadDraft(project);
    newThread.begin(draft);
    scopes.setAttachments(createDraftKey(draftKey(undefined, draft)), [{ id: 1, kind: "image", mimeType: "image/png", data: "", previewUrl: "" } as never]);
    leave();
    expect(rows()).toMatchObject([{ draftId: draft.draftId, preview: "", attachments: 1 }]);
    expect(setup(storage).rows()).toEqual([]);
  });

  it("lists newest first and forgets a discarded draft with its composer", () => {
    const { scopes, newThread, drafts, rows, type, leave } = setup();
    const older = { ...createNewThreadDraft(project), createdAt: 1 };
    const newer = { ...createNewThreadDraft({ projectPath: "/repos/other", projectName: "other" }), createdAt: 2 };
    newThread.begin(older);
    type(older, "older");
    leave();
    newThread.begin(newer);
    type(newer, "newer");
    expect(rows().map((row) => [row.preview, row.active])).toEqual([["newer", true], ["older", false]]);

    drafts.discard(older);
    expect(rows().map((row) => row.preview)).toEqual(["newer"]);
    expect(scopes.getSnapshot(createDraftKey(draftKey(undefined, older))).draft).toBe("");
  });

  it("keeps a promoted draft until a nonempty thread shell arrives", () => {
    const { newThread, drafts, threads, rows, type } = setup();
    const draft = createNewThreadDraft(project);
    newThread.begin(draft);
    type(draft, "Ship it");
    newThread.set(undefined);
    drafts.handoff(draft.draftId, "created");
    expect(rows()).toMatchObject([{ preview: "Ship it", sessionId: "created" }]);
    const shell = { id: "created", path: "/created.jsonl", title: "Ship it", modifiedAt: 1, ...project, messageCount: 0 };
    threads.applyThreadShell("created", shell);
    expect(rows()).toHaveLength(1);
    threads.applyThreadShell("created", { ...shell, messageCount: 1 });
    expect(rows()).toEqual([]);
  });

  it("keeps the title while the first message is on its way, and keeps no draft that is being sent", async () => {
    const { storage, scopes, newThread, drafts, rows, type } = setup();
    const draft = createNewThreadDraft(project);
    newThread.begin(draft);
    type(draft, "Ship it");
    const scope = createDraftKey(draftKey(undefined, draft));
    const handle = await scopes.beginSubmission(scope);
    expect("attachments" in handle).toBe(true);
    expect(scopes.getSnapshot(scope).draft).toBe("");
    expect(rows()[0]?.preview).toBe("Ship it");
    expect(drafts.keep(draft)).toBe(false);
    // The host took it; the draft waits for its thread and keeps the title it sent.
    if ("settle" in handle) handle.settle({ accepted: true });
    writeComposerDraft(storage, scope, "");
    expect(scopes.getSnapshot(scope).submissionPending).toBe(false);
    expect(rows()[0]?.preview).toBe("Ship it");
    type(draft, "Next thought");
    expect(rows()[0]?.preview).toBe("Next thought");
  });

  it("forgets a draft whose first prompt started a thread in the background once it is left empty", async () => {
    const { storage, scopes, newThread, drafts, rows, type, leave } = setup();
    const draft = createNewThreadDraft(project);
    newThread.begin(draft);
    type(draft, "Run it elsewhere");
    const scope = createDraftKey(draftKey(undefined, draft));
    const handle = await scopes.beginSubmission(scope);
    writeComposerDraft(storage, scope, "");
    drafts.startedElsewhere(draft.draftId);
    if ("settle" in handle) handle.settle({ accepted: true });
    expect(rows()).toMatchObject([{ draftId: draft.draftId, preview: "", active: true }]);
    expect(rows()[0]?.submitting).toBeUndefined();
    leave();
    expect(rows()).toEqual([]);
  });
});
