import { describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "./extension-system";
import { FollowUpQueueStore } from "../workbench/follow-up-queue";
import { returnToComposer } from "./use-follow-up-queue";

const image = { kind: "image" as const, name: "a.png", mimeType: "image/png", data: "AA", size: 1 };

describe("returning queued messages to the composer", () => {
  it("drains a thread's queue oldest first", () => {
    const store = new FollowUpQueueStore();
    store.enqueue("s", { text: "one", attachments: [] });
    store.enqueue("s", { text: "two", attachments: [] });
    expect(store.drain("s").map((item) => item.text)).toEqual(["one", "two"]);
    expect(store.list("s")).toEqual([]);
  });

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
