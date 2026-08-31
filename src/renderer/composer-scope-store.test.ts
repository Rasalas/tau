// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  ComposerScopeStore,
  createDraftKey,
  type ComposerScopePersistence,
} from "./composer-scope-store";
import { writeComposerDraft } from "./draft-store";

function memoryPersistence(): ComposerScopePersistence {
  const records = new Map<string, Parameters<ComposerScopePersistence["save"]>[0]>();
  return {
    load: async (key) => records.get(key),
    save: async (record) => { records.set(record.key, structuredClone(record)); },
    delete: async (key) => { records.delete(key); },
  };
}

describe("ComposerScopeStore", () => {
  it("hydrates text and image data into a fresh store instance", async () => {
    const persistence = memoryPersistence();
    const key = createDraftKey("new:/project");
    const first = new ComposerScopeStore(persistence);
    const state = first.ensure(key);
    state.draft = "keep this draft";
    state.attachments = [{
      id: 1, kind: "image", name: "diagram.png", mimeType: "image/png", data: "aW1hZ2U=", size: 5,
      previewUrl: "data:image/png;base64,aW1hZ2U=",
    }];
    first.persist(key, (error) => { throw error; });
    await state.persistenceQueue;

    const second = new ComposerScopeStore(persistence);
    let changed = false;
    second.subscribe(key, () => { changed = true; });
    second.hydrate(key, (error) => { throw error; });
    await second.ensure(key).persistenceQueue;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(changed).toBe(true);
    expect(second.ensure(key)).toMatchObject({
      draft: "keep this draft",
      attachments: [{ name: "diagram.png", data: "aW1hZ2U=", previewUrl: "data:image/png;base64,aW1hZ2U=" }],
    });
  });

  it("does not let hydration overwrite a newer local edit", async () => {
    let resolveLoad!: (record: undefined) => void;
    const persistence: ComposerScopePersistence = {
      load: () => new Promise<undefined>((resolve) => { resolveLoad = resolve; }),
      save: async () => {},
      delete: async () => {},
    };
    const store = new ComposerScopeStore(persistence);
    const key = createDraftKey("thread:one");
    const state = store.ensure(key);
    store.subscribe(key, () => { throw new Error("stale hydration applied"); });
    store.hydrate(key, (error) => { throw error; });
    state.draft = "newer edit";
    state.revision += 1;
    resolveLoad(undefined);
    await Promise.resolve();
    expect(state.draft).toBe("newer edit");
  });

  it("does not restore an attachment after it was removed while hydration was pending", async () => {
    let resolveLoad!: (record: Parameters<ComposerScopePersistence["save"]>[0]) => void;
    const persisted = {
      key: "thread:remove",
      draft: "old",
      revision: 1,
      updatedAt: 1,
      attachments: [{ id: 1, kind: "image" as const, name: "old.png", mimeType: "image/png", data: "aA==", size: 1 }],
    };
    const persistence: ComposerScopePersistence = {
      load: () => new Promise((resolve) => { resolveLoad = resolve; }),
      save: async () => {},
      delete: async () => {},
    };
    const store = new ComposerScopeStore(persistence);
    const key = createDraftKey("thread:remove");
    const state = store.ensure(key);
    let notifications = 0;
    store.subscribe(key, () => { notifications += 1; });
    store.hydrate(key, (error) => { throw error; });
    store.setAttachments(key, [], (error) => { throw error; });
    const afterRemoval = notifications;
    resolveLoad(persisted);
    await Promise.resolve();
    expect(notifications).toBe(afterRemoval);
    expect(state.attachments).toEqual([]);
  });

  it("clears a persistence error after a later write succeeds", async () => {
    let attempts = 0;
    const persistence: ComposerScopePersistence = {
      load: async () => undefined,
      save: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("quota exceeded");
      },
      delete: async () => {},
    };
    const store = new ComposerScopeStore(persistence);
    const key = createDraftKey("thread:quota");
    const errors: unknown[] = [];
    store.setDraft(key, "first", (error) => errors.push(error));
    await store.ensure(key).persistenceQueue;
    expect(errors).toHaveLength(1);
    expect(store.ensure(key).persistenceError).toMatch(/quota/u);
    store.setDraft(key, "second", (error) => errors.push(error));
    await store.ensure(key).persistenceQueue;
    expect(store.ensure(key).persistenceError).toBeUndefined();
    expect(store.ensure(key).draft).toBe("second");
  });

  it("migrates legacy attachment records without replacing newer local text", async () => {
    const key = createDraftKey("thread:legacy");
    writeComposerDraft(window.localStorage, key, "new local text");
    const persistence: ComposerScopePersistence = {
      load: async () => ({
        key,
        draft: "old persisted text",
        attachments: [{ id: 2, kind: "image", name: "legacy.png", mimeType: "image/png", data: "aA==", size: 1 }],
      }),
      save: async () => {},
      delete: async () => {},
    };
    const store = new ComposerScopeStore(persistence);
    let changed = false;
    store.subscribe(key, () => { changed = true; });
    store.hydrate(key, (error) => { throw error; });
    await Promise.resolve();
    expect(changed).toBe(true);
    expect(store.ensure(key)).toMatchObject({ draft: "new local text", attachments: [{ name: "legacy.png" }] });
  });
});
