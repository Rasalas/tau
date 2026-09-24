import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL_VERSION } from "../shared/host-protocol";
import { createNewThreadRequestId, type HostSnapshot, type ThreadIndexSnapshot, type UiMessage } from "../shared/contracts";
import { createMemoryStorage } from "./client-storage";
import { createDraftKey } from "./composer-scope-store";
import { HostSessionState } from "./host-session-state";
import { transcriptNavigationScopeKey, type NewThreadSubmissionRecovery } from "./app-state";
import { draftKey, type NewThreadDraft } from "./draft-store";
import { ThreadStore } from "./thread-store";
import { ThreadViewStore } from "./thread-view-store";
import { TranscriptHistoryController } from "./transcript-history";
import { WorkbenchSession } from "./workbench-session";
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

function build(cached?: { snapshot?: HostSnapshot; threadIndex?: ThreadIndexSnapshot }) {
  const view = new ThreadViewStore(cached?.snapshot);
  const threads = new ThreadStore();
  const history = new TranscriptHistoryController(cached?.snapshot, cached?.threadIndex, view.details);
  const storage = createMemoryStorage();
  const hostSession = new HostSessionState();
  const notices: string[] = [];
  const newThread = {
    current: () => undefined,
    set: () => undefined,
    requestId: () => undefined,
    promoteFromHostReport: () => false,
    promoteFromUserMessage: () => undefined,
  };
  const store = new WorkbenchStore({
    view,
    threads,
    history,
    storage,
    hostSession,
    newThread,
    turn: { current: () => undefined, set: () => true },
    notify: (message) => notices.push(message),
  }, cached);
  return { history, hostSession, notices, store, storage, threads, view };
}

describe("WorkbenchStore", () => {
  it("applies a snapshot to the thread on screen and the thread store", () => {
    const { hostSession, store, threads, view } = build();
    let markedBeforeSnapshotNotify: string | undefined;
    view.subscribeToSnapshot(() => {
      markedBeforeSnapshotNotify = hostSession.sessionIdFor("one");
    });

    expect(store.applySnapshot(snapshot)).toBe(true);
    expect(view.getSnapshot()?.sessionId).toBe("one");
    expect(view.getTranscript().messages.map((message) => message.id)).toEqual(["m1"]);
    expect(threads.getSnapshot().activeThreadId).toBe("one");
    expect(store.getCachedSnapshot()?.sessionId).toBe("one");
    expect(hostSession.sessionIdFor("one")).toBe("one");
    expect(markedBeforeSnapshotNotify).toBe("one");
  });

  it("does not treat constructor cache data as host confirmation", () => {
    const { hostSession, store, view } = build({ snapshot });

    expect(store.getCachedSnapshot()?.sessionId).toBe("one");
    expect(view.getSnapshot()?.sessionId).toBe("one");
    expect(hostSession.sessionIdFor("one")).toBeUndefined();
  });

  it("does not mark a stale bootstrap result before its request guard", () => {
    const { history, hostSession, store } = build();
    const stale = history.beginBootstrap();
    history.beginBootstrap();

    expect(store.applySnapshot(snapshot, stale)).toBe(false);
    expect(hostSession.sessionIdFor("one")).toBeUndefined();
  });

  it("marks the host path before an ignored thread detail is rejected", () => {
    const { history, hostSession, store, view } = build();
    history.syncSnapshot(snapshot);
    const cachedDetail = history.getDetail("one");
    history.beginThreadSwitch("other");

    store.applyHostUpdate({
      version: HOST_PROTOCOL_VERSION,
      type: "thread-detail",
      detail: { sessionId: "one", messages: [], isStreaming: false, activeTools: [] },
    });

    expect(hostSession.sessionIdFor("one")).toBe("one");
    expect(history.getDetail("one")).toBe(cachedDetail);
    expect(view.getSnapshot()).toBeUndefined();
    expect(view.getTranscript().messages).toEqual([]);
    expect(store.getCachedSnapshot()?.sessionId).toBeUndefined();
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

  it("keeps a new thread catalog that arrives before its first accepted detail", () => {
    const { history, store, view } = build();
    store.applySnapshot({
      ...snapshot,
      model: { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    });
    store.applyHostUpdate({
      version: HOST_PROTOCOL_VERSION,
      type: "catalog",
      catalog: {
        sessionId: "two",
        models: [],
        model: { provider: "openai-codex", id: "gpt-6-astra", name: "GPT-6 Astra" },
        thinkingLevel: "medium",
        thinkingLevels: ["medium"],
        allTools: [],
        extensionCount: 0,
      },
    });
    expect(history.prepareActionDetail("two")).toBe(true);
    store.applyHostUpdate({
      version: HOST_PROTOCOL_VERSION,
      type: "thread-detail",
      detail: { sessionId: "two", messages: [], isStreaming: false, activeTools: [] },
    });
    expect(view.getSnapshot()?.model?.id).toBe("gpt-6-astra");
    expect(history.getCurrentSnapshot()?.model?.id).toBe("gpt-6-astra");
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

  // The renderer resyncs every kit when the workspace id changes, so a detail must not drop it.
  it("keeps the workspace id from the bootstrap through the details that follow", () => {
    const { history, store, view } = build();
    store.applyBootstrap({
      version: HOST_PROTOCOL_VERSION,
      threadIndex,
      detail: { sessionId: "one", messages: snapshot.messages, isStreaming: false, activeTools: [] },
      catalog: { models: [], thinkingLevel: "medium", thinkingLevels: [], allTools: [], extensionCount: 0 },
      project: { cwd: "/w/one", workspaceId: "ws1_one", displayPath: "~/w/one", label: "main" },
    }, history.beginBootstrap());
    expect(view.getSnapshot()?.workspaceId).toBe("ws1_one");
    store.applyHostUpdate({ version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: { sessionId: "one", messages: [], isStreaming: false, activeTools: [] } });
    expect(view.getSnapshot()?.workspaceId).toBe("ws1_one");
    expect(view.getSnapshot()?.displayPath).toBe("~/w/one");
  });

  it("keeps a project update's workspace id when the next detail arrives", () => {
    const { history, store, view } = build();
    store.applySnapshot(snapshot);
    store.applyHostUpdate({ version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd: "/w/one", workspaceId: "ws1_one" } });
    store.applyHostUpdate({ version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: { sessionId: "one", messages: [], isStreaming: false, activeTools: [] } });
    expect(view.getSnapshot()?.workspaceId).toBe("ws1_one");
    expect(history.getCurrentSnapshot()?.workspaceId).toBe("ws1_one");
  });

  it("refuses an action result whose thread transition is no longer the current one", () => {
    const { history, store } = build();
    store.applySnapshot(snapshot);
    const stale = history.beginThreadSwitch("one");
    history.beginThreadSwitch("two");
    expect(store.applyActionResult({ updates: [] }, stale)).toBe(false);
  });

  it("returns a correlated observation after reducing detail; Session promotes it once", () => {
    const session = new WorkbenchSession({
      storage: createMemoryStorage(),
      notification: {
        notifyPromptSubmitted: () => {
          expect(session.view.details.get("created")?.messages).toHaveLength(1);
          return true;
        },
      },
    });
    session.threads.setActiveThread("old");
    const requestId = createNewThreadRequestId("new-thread");
    const pending: NewThreadDraft = { kind: "draft", draftId: "draft-1", projectPath: "/w/one", projectName: "one" };
    session.newThread.begin(pending);
    const clientMessage: UiMessage = {
      id: "entry-1",
      clientMessageId: "client-1",
      clientTurnId: "turn-1",
      role: "user",
      text: "hello",
      timestamp: 1,
    };
    const draftScope = createDraftKey(draftKey(undefined, pending));
    session.scopes.setDraft(draftScope, "hello");
    const recovery: NewThreadSubmissionRecovery = {
      pending,
      requestId,
      scopeRef: session.scopes.createScopeReference(draftScope),
      draft: "hello",
      attachments: [],
      optimistic: { ...clientMessage, id: "local-client-1" },
      ipcPending: true,
    };
    session.view.setOptimisticMessages([{ scope: draftScope, message: recovery.optimistic }]);
    session.turn.set({
      turnId: "turn-1",
      scope: { kind: "draft", projectPath: pending.projectPath, draftId: pending.draftId },
      clientMessageId: clientMessage.clientMessageId,
      text: clientMessage.text,
    });
    session.delivery.register(clientMessage.clientMessageId!, recovery);
    session.history.prepareActionDetail("created");

    session.applyHostUpdate({
      version: HOST_PROTOCOL_VERSION,
      type: "thread-detail",
      detail: { sessionId: "created", requestId, messages: [clientMessage], isStreaming: true, activeTools: [] },
    });

    expect(session.newThread.current()).toBeUndefined();
    expect(recovery.scopeRef.scope).toBe(createDraftKey(draftKey("created")));
    expect(session.view.getOptimisticMessages()[0]?.scope).toBe("session:created");
    expect(session.turn.current()?.scopeKey).toBe(transcriptNavigationScopeKey({ cwd: pending.projectPath, sessionId: "created" }));
    expect(session.delivery.hasRecovery(clientMessage.clientMessageId!)).toBe(false);
  });
});
