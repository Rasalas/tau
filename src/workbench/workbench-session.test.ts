import { describe, expect, it, vi } from "vitest";
import { HOST_PROTOCOL_VERSION } from "../shared/host-protocol";
import { createNewThreadRequestId, type HostSnapshot, type UiMessage } from "../shared/contracts";
import { createMemoryStorage } from "./client-storage";
import { createDraftKey } from "./composer-scope-store";
import { draftKey, type NewThreadDraft } from "./draft-store";
import type { NewThreadSubmissionRecovery } from "./app-state";
import { WorkbenchSession } from "./workbench-session";

const pending: NewThreadDraft = {
  kind: "draft",
  draftId: "draft-1",
  projectPath: "/project",
  projectName: "project",
};

const message: UiMessage = {
  id: "entry-1",
  clientMessageId: "client-1",
  clientTurnId: "turn-1",
  role: "user",
  text: "first message",
  timestamp: 1,
};

function addRecovery(session: WorkbenchSession, draft = pending): NewThreadSubmissionRecovery {
  session.newThread.begin(draft);
  const scope = createDraftKey(draftKey(undefined, draft));
  session.scopes.setDraft(scope, draft.draft ?? "first message");
  const recovery: NewThreadSubmissionRecovery = {
    pending: draft,
    requestId: createNewThreadRequestId("new-thread"),
    scopeRef: session.scopes.createScopeReference(scope),
    draft: "first message",
    attachments: [],
    optimistic: { ...message },
    ipcPending: true,
  };
  session.delivery.register(message.clientMessageId!, recovery);
  return recovery;
}

function detail(sessionId: string, options: { requestId?: ReturnType<typeof createNewThreadRequestId>; messages?: UiMessage[]; isStreaming?: boolean } = {}) {
  return {
    version: HOST_PROTOCOL_VERSION,
    type: "thread-detail" as const,
    detail: {
      sessionId,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      messages: options.messages ?? [message],
      isStreaming: options.isStreaming ?? true,
      activeTools: [],
    },
  };
}

describe("WorkbenchSession", () => {
  it("owns cached stores without treating the cached snapshot as host confirmation", () => {
    const snapshot: HostSnapshot = {
      cwd: "/project",
      sessionId: "cached",
      sessionTitle: "Cached",
      models: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      allTools: [],
      extensionCount: 0,
      messages: [],
      isStreaming: false,
      activeTools: [],
    };
    const session = new WorkbenchSession({ storage: createMemoryStorage(), cached: { snapshot, threadIndex: { projects: [], sessions: [] } } });

    expect(session.view.getSnapshot()?.sessionId).toBe("cached");
    expect(session.threads.getSnapshot().activeThreadId).toBe("cached");
    expect(session.hostSession.sessionIdFor("cached")).toBeUndefined();
  });

  it("reduces detail before notifying a correlated delivery", () => {
    const seen: string[] = [];
    let reentrantPromotion = false;
    let session!: WorkbenchSession;
    session = new WorkbenchSession({
      storage: createMemoryStorage(),
      notification: {
        notifyPromptSubmitted: () => {
          seen.push(session.view.details.get("created")?.messages[0]?.id ?? "missing");
          reentrantPromotion = session.delivery.promoteRecovery(message.clientMessageId!, "created", message);
          return true;
        },
      },
    });
    session.threads.setActiveThread("old");
    const recovery = addRecovery(session);
    session.history.prepareActionDetail("created");

    session.applyHostUpdate(detail("created", { messages: [message] }));

    expect(seen).toEqual([message.id]);
    expect(reentrantPromotion).toBe(true);
    expect(session.newThread.current()).toBeUndefined();
    expect(session.delivery.hasRecovery(message.clientMessageId!)).toBe(false);
    expect(recovery.scopeRef.scope).toBe(createDraftKey(draftKey("created")));
  });

  it("applies a synthetic detail through the store before finishing settlement", () => {
    const events: string[] = [];
    let session!: WorkbenchSession;
    session = new WorkbenchSession({
      storage: createMemoryStorage(),
      notification: {
        notifyPromptSubmitted: () => {
          events.push(`notify:${session.view.details.get("created")?.messages[0]?.id ?? "missing"}`);
          return true;
        },
      },
    });
    session.threads.setActiveThread("old");
    const recovery = addRecovery(session);

    expect(session.delivery.settleDelivery(message.clientMessageId!, "created", { accepted: true })).toBe(true);

    expect(session.view.details.get("created")?.messages[0]?.id).toBe(message.id);
    expect(events).toEqual(["notify:entry-1"]);
    expect(session.delivery.hasRecovery(message.clientMessageId!)).toBe(false);
    expect(recovery.promoted).toBe(true);
  });

  it("processes each action update before reducing the next one", () => {
    const session = new WorkbenchSession({ storage: createMemoryStorage() });
    session.threads.setActiveThread("old");
    addRecovery(session);

    expect(session.applyActionResult({
      updates: [
        detail("created"),
        { version: HOST_PROTOCOL_VERSION, type: "run", sessionId: "created", event: "settled" },
      ],
    })).toBe(true);

    expect(session.threads.getSnapshot().activeThreadId).toBe("created");
    expect(session.threads.getActivity().isStreaming).toBe(false);
  });

  it("keeps a live recovery when an accepted settlement names a stale session", () => {
    const session = new WorkbenchSession({ storage: createMemoryStorage() });
    const recovery = addRecovery(session);
    recovery.sessionId = "created";

    expect(session.delivery.settleDelivery(message.clientMessageId!, "other", { accepted: true })).toBe(true);

    expect(session.delivery.hasRecovery(message.clientMessageId!)).toBe(true);
    expect(session.newThread.current()?.draftId).toBe(pending.draftId);
  });

  it("does not let a stale held recovery consume a different pending draft", () => {
    const session = new WorkbenchSession({ storage: createMemoryStorage() });
    const recovery = addRecovery(session);
    recovery.sessionId = "created";
    const otherDraft: NewThreadDraft = { ...pending, draftId: "draft-2", projectPath: "/other" };
    session.newThread.begin(otherDraft);
    session.history.prepareActionDetail("other");

    session.applyHostUpdate(detail("other", { messages: [message] }));

    expect(session.newThread.current()?.draftId).toBe(otherDraft.draftId);
    expect(session.delivery.hasRecovery(message.clientMessageId!)).toBe(true);
  });

  it("reports bootstrap detail to delivery after applying the snapshot", () => {
    const hostMessage = { ...message, clientMessageId: "bootstrap-client" };
    const seen: string[] = [];
    let session!: WorkbenchSession;
    session = new WorkbenchSession({
      storage: createMemoryStorage(),
      notification: {
        notifyPromptSubmitted: () => {
          seen.push(session.view.getSnapshot()?.sessionId ?? "missing");
          return true;
        },
      },
    });
    session.newThread.begin(pending);
    const scope = createDraftKey(draftKey(undefined, pending));
    const recovery: NewThreadSubmissionRecovery = {
      pending,
      requestId: createNewThreadRequestId("bootstrap"),
      scopeRef: session.scopes.createScopeReference(scope),
      draft: hostMessage.text,
      attachments: [],
      optimistic: hostMessage,
      ipcPending: true,
    };
    session.delivery.register(hostMessage.clientMessageId!, recovery);
    const request = session.history.beginBootstrap();

    expect(session.applySnapshot({
      cwd: pending.projectPath,
      sessionId: "created",
      sessionTitle: "Created",
      models: [],
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      allTools: [],
      extensionCount: 0,
      messages: [hostMessage],
      isStreaming: true,
      activeTools: [],
    }, request)).toBe(true);

    expect(seen).toEqual(["created"]);
    expect(session.delivery.hasRecovery(hostMessage.clientMessageId!)).toBe(false);
  });

  it("carries the live composer draft across project navigation without a DOM reader", () => {
    const session = new WorkbenchSession({ storage: createMemoryStorage() });
    session.newThread.begin({ ...pending, draft: "older persisted text" });
    session.scopes.setDraft(createDraftKey(draftKey(undefined, pending)), "latest typed text");

    session.applyHostResult({ version: HOST_PROTOCOL_VERSION, updates: [
      { version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd: "/other" } },
      detail("destination", { messages: [], isStreaming: false }),
    ] });

    expect(session.scopes.getSnapshot(createDraftKey(draftKey("destination"))).draft).toBe("latest typed text");
    session.applyHostResult({ version: HOST_PROTOCOL_VERSION, updates: [detail("another", { messages: [], isStreaming: false })] }, false);
    expect(session.scopes.getSnapshot(createDraftKey(draftKey("another"))).draft).toBe("");
  });

  it("turns a rejected notification promise into a session notice", async () => {
    const session = new WorkbenchSession({
      storage: createMemoryStorage(),
      notification: { notifyPromptSubmitted: () => Promise.reject(new Error("registry down")) },
    });
    addRecovery(session);
    expect(session.delivery.settleDelivery(message.clientMessageId!, "created", { accepted: true })).toBe(true);

    await vi.waitFor(() => expect(session.view.getNotice()?.message).toBe("registry down"));
  });
});
