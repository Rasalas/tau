import { describe, expect, it } from "vitest";
import type { UiSession } from "../shared/contracts";
import { createMemoryStorage } from "./client-storage";
import { createDraftKey } from "./composer-scope-store";
import { createNewThreadDraft, draftKey, draftKeyOwner } from "./draft-store";
import { EMPTY_STAGE, openFileTab } from "./stage";
import { dockStateKey, stageStateKey, threadStageKey } from "./storage-keys";
import { MAX_THREAD_STAGES, SETTLED_STAGE_AGE_MS, stageOwner, ThreadStages, type ThreadStage } from "./thread-stages";
import { WorkbenchSession } from "./workbench-session";

const DAY = 24 * 60 * 60 * 1000;
const workspace = "ws-1";

function thread(id: string, modifiedAt: number, extra: Partial<UiSession> = {}): UiSession {
  return { id, path: `/sessions/${id}.jsonl`, title: id, modifiedAt, projectPath: "/repo", workspaceId: workspace, projectName: "repo", messageCount: 1, ...extra };
}

const withTab: ThreadStage = { stage: openFileTab(EMPTY_STAGE, "src/a.ts", { pin: true }), maximized: false, dock: { open: false } };

function store(options: { threads?: UiSession[]; drafts?: string[]; settled?: string[]; now?: () => number } = {}) {
  const storage = createMemoryStorage();
  const stages = new ThreadStages({
    storage,
    threads: () => options.threads ?? [],
    drafts: () => options.drafts ?? [],
    settled: () => options.settled ?? [],
    ...(options.now ? { now: options.now } : {}),
  });
  return { storage, stages };
}

describe("stageOwner", () => {
  it("names a thread by its id and a draft by its draft id, until the draft has a thread", () => {
    const draft = createNewThreadDraft({ projectPath: "/repo", projectName: "repo" });
    expect(stageOwner("t1")).toBe("thread:t1");
    expect(stageOwner("t1", draft)).toBe(`draft:${draft.draftId}`);
    expect(stageOwner(undefined, { ...draft, sessionId: "t2" })).toBe("thread:t2");
    expect(stageOwner(undefined)).toBeUndefined();
  });

  it("reads the owner back from a composer scope", () => {
    const draft = createNewThreadDraft({ projectPath: "C:\\repo", projectName: "repo" });
    expect(draftKeyOwner(draftKey(undefined, draft)!)).toEqual({ draftId: draft.draftId });
    expect(draftKeyOwner(draftKey("t1")!)).toEqual({ sessionId: "t1" });
    expect(draftKeyOwner("thread:default")).toBeUndefined();
  });
});

describe("ThreadStages", () => {
  it("round-trips a layout and forgets an empty one", () => {
    const { stages, storage } = store();
    const layout: ThreadStage = { ...withTab, maximized: true, dock: { open: true, activePanel: "files", drawer: "terminal" } };
    stages.write("thread:a", layout);
    expect(stages.read("thread:a")).toEqual(layout);

    stages.write("thread:a", { stage: EMPTY_STAGE, maximized: true, dock: { open: false, activePanel: "files" } });
    expect(storage.get(threadStageKey("thread:a"))).toBeNull();
  });

  it("moves a draft's layout to its thread, without overwriting one the thread has", () => {
    const { stages, storage } = store();
    stages.write("draft:d1", withTab);
    stages.promote("d1", "t1");
    expect(storage.get(threadStageKey("draft:d1"))).toBeNull();
    expect(stages.read("thread:t1")?.stage.tabs).toHaveLength(1);
    // Writing under the draft's name after the promotion lands on the thread.
    stages.write("draft:d1", { ...withTab, maximized: true });
    expect(stages.read("thread:t1")?.maximized).toBe(true);

    stages.write("draft:d2", withTab);
    stages.write("thread:t2", { ...withTab, stage: openFileTab(EMPTY_STAGE, "kept.ts") });
    stages.promote("d2", "t2");
    expect(stages.read("thread:t2")?.stage.tabs.map((tab) => tab.id)).toEqual(["file:kept.ts"]);
  });

  describe("taking the project's stage from before", () => {
    function legacy(storage: ReturnType<typeof createMemoryStorage>) {
      storage.set(stageStateKey(workspace), JSON.stringify({ tabs: [{ id: "file:src/old.ts", kind: "file", path: "src/old.ts", view: "source", preview: false }] }));
      storage.set(dockStateKey(workspace), JSON.stringify({ open: true, openedPanels: [], drawer: "terminal" }));
    }

    it("goes to the first thread shown, once", () => {
      const { stages, storage } = store({ threads: [thread("old", 1), thread("new", 2)] });
      legacy(storage);
      expect(stages.read("thread:old", workspace)).toMatchObject({ dock: { open: true, drawer: "terminal" } });
      expect(stages.read("thread:new", workspace)).toBeUndefined();
      expect(stages.read("thread:old", workspace)?.stage.tabs).toHaveLength(1);
    });

    it("goes to the project's latest thread when another thread was shown first", () => {
      const { stages, storage } = store({ threads: [thread("other", 9, { workspaceId: "ws-2" }), thread("old", 1), thread("new", 2), thread("child", 5, { parentThreadId: "new" })] });
      legacy(storage);
      expect(stages.read("thread:other", "ws-2")).toBeUndefined();
      expect(stages.read("thread:old", workspace)).toBeUndefined();
      expect(stages.read("thread:child", workspace)).toBeUndefined();
      expect(stages.read("thread:new", workspace)?.stage.tabs).toHaveLength(1);
    });

    it("never goes to a draft", () => {
      const { stages, storage } = store({ threads: [thread("t", 1)] });
      legacy(storage);
      expect(stages.read("draft:d", workspace)).toBeUndefined();
      expect(storage.get(stageStateKey(workspace))).not.toBeNull();
    });
  });

  describe("sweep", () => {
    it("forgets a deleted thread's layout, a gone draft's and a long settled thread's", () => {
      let now = 100 * DAY;
      const { stages, storage } = store({
        threads: [thread("live", 1), thread("settled-old", 1), thread("settled-recent", 1)],
        drafts: ["kept"],
        settled: ["settled-old", "settled-recent"],
        now: () => now,
      });
      for (const owner of ["thread:live", "thread:deleted", "thread:settled-old", "draft:kept", "draft:gone"]) stages.write(owner, withTab);
      now += SETTLED_STAGE_AGE_MS + 1;
      stages.write("thread:settled-recent", withTab);
      stages.write("thread:just-made", withTab);
      stages.sweep();

      const left = storage.keys("tau.stage.v2:").sort();
      expect(left).toEqual(["thread:just-made", "thread:live", "thread:settled-recent", "draft:kept"].map(threadStageKey).sort());
    });

    it("keeps the layout on screen and the latest ones up to the cap", () => {
      let now = 1;
      const { stages, storage } = store({ threads: Array.from({ length: MAX_THREAD_STAGES + 5 }, (_, index) => thread(`t${index}`, index)), now: () => now++ });
      for (let index = 0; index < MAX_THREAD_STAGES + 5; index += 1) stages.write(`thread:t${index}`, withTab);
      stages.read("thread:t0");
      stages.sweep();
      const left = storage.keys("tau.stage.v2:");
      expect(left).toHaveLength(MAX_THREAD_STAGES + 1);
      expect(left).toContain(threadStageKey("thread:t0"));
      expect(left).not.toContain(threadStageKey("thread:t1"));
    });
  });
});

describe("WorkbenchSession and stages", () => {
  it("hands a draft's stage to its thread when the draft's scope becomes the thread's", () => {
    const session = new WorkbenchSession({ storage: createMemoryStorage() });
    const draft = createNewThreadDraft({ projectPath: "/repo", projectName: "repo" });
    session.stages.write(stageOwner(undefined, draft)!, withTab);
    session.scopes.moveScope(createDraftKey(draftKey(undefined, draft)), createDraftKey(draftKey("t1")));
    expect(session.stages.read("thread:t1")?.stage.tabs).toHaveLength(1);
  });

  it("forgets a thread's stage when the host removes the thread", () => {
    const session = new WorkbenchSession({ storage: createMemoryStorage() });
    session.stages.write("thread:t1", withTab);
    session.applyHostUpdate({ version: 1, type: "thread-shell", update: { sessionId: "t1", removed: true } });
    expect(session.stages.read("thread:t1")).toBeUndefined();
  });
});
