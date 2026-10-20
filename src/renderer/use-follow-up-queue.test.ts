// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UiQueuedPrompt } from "../shared/contracts";
import { createMemoryStorage } from "../workbench/client-storage";
import { ComposerScopeStore, createDraftKey } from "../workbench/composer-scope-store";
import { draftKey, writeComposerDraft } from "../workbench/draft-store";
import type { HostClient } from "../workbench/host-client";
import { ThreadStore } from "../workbench/thread-store";
import type { WorkbenchActions } from "./extension-system";
import { requeue, returnToComposer, threadComposer, useFollowUpQueue } from "./use-follow-up-queue";

const image = { kind: "image" as const, name: "a.png", mimeType: "image/png", data: "AA", size: 1 };

describe("returning queued messages to the composer", () => {
  it("puts their text below the draft and their images beside the draft's", () => {
    let draft = "draft on top";
    let images = [{ ...image, name: "old.png" }];
    const actions = {
      composerDraft: () => draft,
      setComposerDraft: (text: string) => { draft = text; },
      composerImages: () => images,
      setComposerImages: (next: typeof images) => { images = [...next]; },
      notify: vi.fn(),
    } as unknown as WorkbenchActions;
    returnToComposer(actions, [
      { id: "1", text: "first ", attachments: [image] },
      { id: "2", text: "second", attachments: [{ kind: "file", name: "f", mimeType: "text/plain", path: "/f", size: 1 }] },
    ]);
    expect(draft).toBe("draft on top\n\nfirst\n\nsecond");
    expect(images.map((entry) => entry.name)).toEqual(["old.png", "a.png"]);
    expect(actions.notify).toHaveBeenCalledWith(expect.stringContaining("attach them again"));
  });
});

describe("queued messages of a thread the user leaves while the host answers", () => {
  function queueOf(take: (threadId: string, id?: string) => Promise<UiQueuedPrompt[]>) {
    let shown = "A";
    const storage = createMemoryStorage();
    const scopes = new ComposerScopeStore();
    const submit = vi.fn(async () => ({ accepted: true as const }));
    const onScreen = { composerDraft: vi.fn(() => ""), setComposerDraft: vi.fn(), notify: vi.fn() } as unknown as WorkbenchActions;
    const rendered = renderHook(({ sessionId }) => useFollowUpQueue({
      client: { takeQueued: vi.fn(take) } as unknown as HostClient,
      threads: new ThreadStore(),
      sessionId,
      currentSessionId: () => shown,
      isRunning: () => true,
      submit,
      setNotice: vi.fn(),
      actions: () => onScreen,
      composerOf: (threadId) => threadComposer(scopes, storage, threadId, vi.fn()),
    }), { initialProps: { sessionId: "A" } });
    const leave = () => { shown = "B"; rendered.rerender({ sessionId: "B" }); };
    return { ...rendered, leave, submit, scopes, storage, onScreen };
  }

  it("sends one sent now to its own thread", async () => {
    let taken!: (items: UiQueuedPrompt[]) => void;
    const queue = queueOf(() => new Promise((resolve) => { taken = resolve; }));
    let sending!: Promise<void>;
    act(() => { sending = queue.result.current.steerQueued("q1"); });
    queue.leave();
    await act(async () => { taken([{ id: "q1", text: "for A", attachments: [] }]); await sending; });
    expect(queue.submit).toHaveBeenCalledExactlyOnceWith("for A", [], undefined, undefined, "A");
  });

  it("returns a stopped thread's queue to that thread's composer, below its saved draft", async () => {
    const take = vi.fn(async () => [{ id: "q1", text: "for A", attachments: [] }]);
    const queue = queueOf(take);
    queue.leave();
    writeComposerDraft(queue.storage, draftKey("A"), "saved in A");
    act(() => queue.result.current.returnQueued(undefined, "A"));
    expect(take).toHaveBeenCalledWith("A", undefined);
    await vi.waitFor(() => expect(queue.scopes.getSnapshot(createDraftKey(draftKey("A"))).draft).toBe("saved in A\n\nfor A"));
    expect(queue.onScreen.setComposerDraft).not.toHaveBeenCalled();
  });
});

describe("undoing a removal from the queue", () => {
  it("queues the message again with its time, and puts one of the line back in its place", async () => {
    const queueMessage = vi.fn(async () => ({ id: "again" }));
    const moveQueued = vi.fn(async () => undefined);
    await requeue({ queueMessage, moveQueued }, "thread", { id: "old", text: "second thoughts", attachments: [image] }, 1);
    expect(queueMessage).toHaveBeenCalledWith("thread", "second thoughts", [image], undefined, undefined);
    expect(moveQueued).toHaveBeenCalledWith("thread", "again", 1);

    moveQueued.mockClear();
    await requeue({ queueMessage, moveQueued }, "thread", { id: "planned", text: "later", attachments: [], deliverAt: 99 }, 2);
    expect(queueMessage).toHaveBeenLastCalledWith("thread", "later", [], undefined, 99);
    expect(moveQueued).not.toHaveBeenCalled();
  });
});
