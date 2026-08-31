// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  ComposerScopeStore,
  createDraftKey,
  type ComposerScopePersistence,
} from "./composer-scope-store";

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
    second.hydrate(key, () => { changed = true; }, (error) => { throw error; });
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
    store.hydrate(key, () => { throw new Error("stale hydration applied"); }, (error) => { throw error; });
    state.draft = "newer edit";
    state.revision += 1;
    resolveLoad(undefined);
    await Promise.resolve();
    expect(state.draft).toBe("newer edit");
  });
});
