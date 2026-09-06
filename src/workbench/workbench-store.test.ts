import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL_VERSION } from "../shared/host-protocol";
import type { HostSnapshot, ThreadIndexSnapshot } from "../shared/contracts";
import { createMemoryStorage } from "./client-storage";
import { ComposerScopeStore } from "./composer-scope-store";
import { ThreadStore } from "./thread-store";
import { ThreadViewStore } from "./thread-view-store";
import { TranscriptHistoryController } from "./transcript-history";
import { WorkbenchStore } from "./workbench-store";

const snapshot: HostSnapshot = {
  cwd: "/w/one",
  projectLabel: "main",
  sessionId: "one",
  sessionTitle: "One",
  messages: [{ id: "m1", role: "user", text: "hello", timestamp: 1 }],
  isStreaming: false,
  activeTools: [],
};

const threadIndex: ThreadIndexSnapshot = {
  projects: [{ path: "/w/one", name: "one", lastOpenedAt: 1 }],
  sessions: [{ id: "one", path: "one.jsonl", title: "One", modifiedAt: 1, projectPath: "/w/one", projectName: "one", messageCount: 1 }],
};

function build() {
  const view = new ThreadViewStore();
  const threads = new ThreadStore();
  const history = new TranscriptHistoryController(undefined, undefined, view.details);
  const storage = createMemoryStorage();
  const notices: string[] = [];
  const store = new WorkbenchStore({
    view,
    threads,
    history,
    scopes: new ComposerScopeStore(),
    storage,
    submission: { notifyHostSnapshot: () => undefined, promoteReportedThread: () => false },
    newThread: { current: () => undefined, requestId: () => undefined, promoteFromHostReport: () => false },
    turn: { current: () => undefined, set: () => true },
    notify: (message) => notices.push(message),
  });
  return { history, notices, store, storage, threads, view };
}

describe("WorkbenchStore", () => {
  it("applies a snapshot to the thread on screen and the thread store", () => {
    const { store, threads, view } = build();
    expect(store.applySnapshot(snapshot)).toBe(true);
    expect(view.getSnapshot()?.sessionId).toBe("one");
    expect(view.getTranscript().messages.map((message) => message.id)).toEqual(["m1"]);
    expect(threads.getSnapshot().activeThreadId).toBe("one");
    expect(store.getCachedSnapshot()?.sessionId).toBe("one");
  });

  it("writes the bootstrap cache only once index and snapshot are both known", () => {
    const { store, storage } = build();
    store.applySnapshot(snapshot);
    expect(storage.keys().length).toBe(0);
    store.applyThreadIndex(threadIndex);
    expect(storage.keys().some((key) => key.includes("bootstrap"))).toBe(true);
  });

  it("routes a run update to the thread store and an error update to the notice", () => {
    const { notices, store, threads } = build();
    store.applySnapshot(snapshot);
    store.applyHostUpdate({ version: HOST_PROTOCOL_VERSION, type: "run", sessionId: "one", event: "started" });
    expect(threads.getSnapshot().isStreaming).toBe(true);
    store.applyHostUpdate({ version: HOST_PROTOCOL_VERSION, type: "error", message: "no runtime" });
    expect(notices).toEqual(["no runtime"]);
  });

  it("ignores an update from a protocol version it does not speak", () => {
    const { store, threads } = build();
    store.applySnapshot(snapshot);
    store.applyHostUpdate({ version: 99, type: "run", sessionId: "one", event: "started" } as never);
    expect(threads.getSnapshot().isStreaming).toBe(false);
  });

  it("applies the updates of an action result in order", () => {
    const { store, threads, view } = build();
    store.applySnapshot(snapshot);
    const applied = store.applyActionResult({
      updates: [
        { version: HOST_PROTOCOL_VERSION, type: "thread-index", index: threadIndex },
        { version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd: "/w/two", label: "feat" } },
      ],
    });
    expect(applied).toBe(true);
    expect(threads.getSnapshot().threads).toHaveLength(1);
    expect(view.getSnapshot()?.cwd).toBe("/w/two");
  });

  it("refuses an action result whose thread transition is no longer the current one", () => {
    const { history, store } = build();
    store.applySnapshot(snapshot);
    const stale = history.beginThreadSwitch("one");
    history.beginThreadSwitch("two");
    expect(store.applyActionResult({ updates: [] }, stale)).toBe(false);
  });
});
