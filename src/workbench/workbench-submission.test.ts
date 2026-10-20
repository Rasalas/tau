import { describe, expect, it, vi } from "vitest";
import type { ClientTurnIdentity, HostSnapshot, UiMessage, UiPromptAttachment } from "../shared/contracts";
import { HOST_PROTOCOL_VERSION } from "../shared/host-protocol";
import type { NewThreadResult } from "../shared/host-protocol";
import type { HostClient } from "./host-client";
import type { SubmissionEnvironment } from "./submission-controller";
import { createMemoryStorage } from "./client-storage";
import { createDraftKey } from "./composer-scope-store";
import { draftKey, writeComposerDraft, writeNewThreadDraft } from "./draft-store";
import { applyHostEvent, type HostEventTargets } from "./host-events";
import { SEND_FAILED_NOTICE } from "./thread-view-store";
import { WorkbenchSession } from "./workbench-session";
import { ConnectionDroppedError } from "../shared/connection-dropped-error";

const snapshot: HostSnapshot = {
  cwd: "/project", sessionId: "previous", sessionTitle: "Previous", models: [],
  thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0,
  messages: [], isStreaming: false, activeTools: [],
};

function harness(storage = createMemoryStorage()) {
  let resolve!: (result: NewThreadResult) => void;
  let reject!: (error: Error) => void;
  let identity!: ClientTurnIdentity;
  const newSession = vi.fn((_text: string, _attachments: UiPromptAttachment[], _workspace: string, turn: ClientTurnIdentity) => {
    identity = turn;
    return new Promise<NewThreadResult>((yes, no) => { resolve = yes; reject = no; });
  });
  const preparePrompt = vi.fn(async () => undefined);
  const sendPrompt = vi.fn(async (..._args: unknown[]) => {});
  const queueMessage = vi.fn(async (..._args: unknown[]) => ({ id: "queued-one" }));
  const client = {
    preparePrompt,
    watchNewThread: () => () => {},
    newSession,
    sendPrompt,
    queueMessage,
  } as unknown as HostClient;
  const environment: SubmissionEnvironment = {
    command: () => undefined, claimNewThread: async () => false,
    prepareNewThread: async () => undefined, accepted: () => {}, submitted: async () => {},
    selection: () => ({ runtime: "pi" }), unsettle: () => {}, preview: () => {},
  };
  const session = new WorkbenchSession({ storage, submission: { client: () => client, environment } });
  session.applySnapshot(snapshot);
  session.newThread.begin({ kind: "draft", draftId: "sending", projectPath: "/project", projectName: "Project" });
  const scope = createDraftKey(draftKey(undefined, session.newThread.current()));
  session.scopes.setDraft(scope, "first prompt");
  return { session, scope, newSession, preparePrompt, sendPrompt, queueMessage, identity: () => identity, resolve: () => resolve({
    version: HOST_PROTOCOL_VERSION, updates: [], sessionId: "created", requestId: identity.newThreadRequestId,
    submission: { accepted: true },
  }), reject: () => reject(new Error("Refused")) };
}

/** Exercise the production live-event route with the session owning its state. */
function liveEcho(session: WorkbenchSession, sessionId: string, message: UiMessage): void {
  applyHostEvent({ type: "user-message", sessionId, message }, {
    registry: { dispatchWorkbenchEvent: () => {} },
    preferences: { unsettle: () => {} },
    threadStore: session.threads, view: session.view,
    applyUserMessage: session.applyUserMessage,
  } as unknown as HostEventTargets);
}

describe("workbench submission", () => {
  it("keeps a received acknowledgement after restart while waiting for the transcript", async () => {
    const storage = createMemoryStorage();
    const first = harness(storage);
    first.session.newThread.set(undefined);
    await first.session.submit({ text: "acknowledged" });
    expect(first.session.view.getOptimisticMessages()[0].message.submission?.state).toBe("sent");
    expect(harness(storage).session.view.getOptimisticMessages()[0].message.submission?.state).toBe("sent");
  });

  it("uses a confirmed queue entry when the request acknowledgement arrives as a drop", async () => {
    const h = harness();
    h.session.newThread.set(undefined);
    h.session.applySnapshot({ ...snapshot, isStreaming: true });
    let fail!: (error: Error) => void;
    h.queueMessage.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const submitted = h.session.submit({ text: "queued once" });
    await vi.waitFor(() => expect(h.queueMessage).toHaveBeenCalledOnce());
    const message = h.session.view.getOptimisticMessages()[0].message;
    h.session.applyThreadIndex({ projects: [], sessions: [{ id: "previous", path: "/s", title: "Previous", projectPath: "/project", projectName: "Project", modifiedAt: 1, messageCount: 1, queued: [{ id: `queued-${message.clientMessageId}`, text: "queued once", attachments: 0 }] }] });
    fail(new ConnectionDroppedError());
    await expect(submitted).resolves.toEqual({ accepted: true });
    expect(h.session.view.getOptimisticMessages()).toEqual([]);
  });

  it("keeps a queue send outside the editor when its acknowledgement is lost", async () => {
    const h = harness();
    h.session.newThread.set(undefined);
    h.session.applySnapshot({ ...snapshot, isStreaming: true });
    h.queueMessage.mockRejectedValueOnce(new ConnectionDroppedError());
    await expect(h.session.submit({ text: "next queued message" })).resolves.toMatchObject({ accepted: false, retained: true });
    const row = h.session.view.getOptimisticMessages()[0];
    expect(row.message.submission?.state).toBe("failed");
    await h.session.retryMessage(row.message.id);
    expect(h.queueMessage).toHaveBeenCalledTimes(2);
    expect(h.queueMessage.mock.calls[1]?.[5]).toEqual(h.queueMessage.mock.calls[0]?.[5]);
    expect(h.session.view.getOptimisticMessages()).toEqual([]);
  });

  it("restores an unconfirmed send after restart and removes it when the transcript confirms it", async () => {
    const storage = createMemoryStorage();
    const first = harness(storage);
    first.session.newThread.set(undefined);
    first.sendPrompt.mockRejectedValueOnce(new ConnectionDroppedError());
    await first.session.submit({ text: "survive restart" });
    const message = first.session.view.getOptimisticMessages()[0].message;
    const restored = harness(storage);
    restored.session.newThread.set(undefined);
    expect(restored.session.view.getOptimisticMessages()[0].message).toMatchObject({ id: message.id, submission: { state: "failed" } });
    await restored.session.retryMessage(message.id);
    expect(restored.sendPrompt.mock.calls[0]?.[3]).toMatchObject({ clientTurnId: message.clientTurnId, clientMessageId: message.clientMessageId });
    liveEcho(restored.session, "previous", { ...message, id: "persisted-user", submission: undefined });
    expect(restored.session.view.getOptimisticMessages()).toEqual([]);
    expect(harness(storage).session.view.getOptimisticMessages()).toEqual([]);
  });

  it("keeps an unconfirmed first message reachable after leaving its empty editor and restarting", async () => {
    const storage = createMemoryStorage();
    const first = harness(storage);
    first.preparePrompt.mockRejectedValueOnce(new ConnectionDroppedError());
    const handle = await first.session.scopes.beginSubmission(first.scope);
    const result = await first.session.submit({ text: "first message awaiting delivery" });
    if ("settle" in handle) handle.settle(result);
    writeComposerDraft(storage, first.scope, "");
    const captured = first.session.view.getOptimisticMessages()[0];
    first.session.drafts.keep(first.session.newThread.current()!);
    first.session.newThread.set(undefined);
    writeNewThreadDraft(storage);
    expect(first.session.drafts.list()).toMatchObject([{ draftId: "sending", preview: "first message awaiting delivery", active: false }]);
    expect(first.session.drafts.list()[0].submitting).toBeUndefined();

    const restored = new WorkbenchSession({ storage });
    expect(restored.drafts.find("sending")).toMatchObject({ projectPath: "/project", draftId: "sending" });
    expect(restored.drafts.find("sending")?.draft).toBeUndefined();
    expect(restored.drafts.list()).toMatchObject([{ draftId: "sending", preview: "first message awaiting delivery" }]);
    restored.newThread.begin(restored.drafts.take("sending")!);
    expect(restored.newThread.current()?.draft).toBeUndefined();
    expect(restored.scopes.getSnapshot(first.scope).draft).toBe("");

    const retry = harness(storage);
    const sending = retry.session.retryMessage(captured.message.id);
    await vi.waitFor(() => expect(retry.newSession).toHaveBeenCalledOnce());
    expect(retry.identity().newThreadRequestId).toBe(captured.requestId);
    retry.resolve();
    await sending;
    retry.session.delivery.settleDelivery(retry.identity().clientMessageId, "created", { accepted: true });
    expect(retry.session.newThread.current()).toBeUndefined();
    expect(retry.session.view.getSnapshot()?.sessionId).toBe("created");
    expect(retry.session.view.getTranscript().messages).toMatchObject([{ text: "first message awaiting delivery" }]);
  });

  it("keeps a failed send in the chat and retries with the same delivery identity", async () => {
    const h = harness();
    h.session.newThread.set(undefined);
    h.sendPrompt.mockRejectedValueOnce(new ConnectionDroppedError());
    await expect(h.session.submit({ text: "keep outside the editor" })).resolves.toMatchObject({ accepted: false, retained: true });
    const failed = h.session.view.getOptimisticMessages()[0];
    expect(failed.message).toMatchObject({ text: "keep outside the editor", submission: { state: "failed" } });
    const identity = h.sendPrompt.mock.calls[0]?.[3];
    await h.session.retryMessage(failed.message.id);
    expect(h.sendPrompt.mock.calls[1]?.[3]).toEqual(identity);
    expect(h.session.view.getOptimisticMessages()).toHaveLength(1);
    expect(h.session.view.getOptimisticMessages()[0].message).toMatchObject({ submission: { state: "sent" } });
  });

  it("accepts a confirmed message even when the send request later loses its connection", async () => {
    const h = harness();
    h.session.newThread.set(undefined);
    let fail!: (error: Error) => void;
    h.sendPrompt.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const submitted = h.session.submit({ text: "already delivered" });
    await vi.waitFor(() => expect(h.sendPrompt).toHaveBeenCalledOnce());
    const optimistic = h.session.view.getOptimisticMessages()[0].message;
    liveEcho(h.session, "previous", { ...optimistic, id: "persisted-user" });
    fail(new Error("The connection to the machine dropped before the job finished."));
    await expect(submitted).resolves.toEqual({ accepted: true });
    expect(h.session.view.getTranscript().messages).toMatchObject([{ id: "persisted-user" }]);
  });

  it("shows the submitted message while prompt preparation is still pending", async () => {
    const h = harness();
    h.session.newThread.set(undefined);
    let finish!: () => void;
    h.preparePrompt.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
    const submitted = h.session.submit({ text: "show immediately" });
    await vi.waitFor(() => expect(h.preparePrompt).toHaveBeenCalledOnce());
    try {
      expect(h.session.view.getOptimisticMessages()).toMatchObject([
        { scope: "session:previous", message: { role: "user", text: "show immediately" } },
      ]);
    } finally {
      finish();
      await submitted;
    }
  });

  it("loads submission on the first command and shares the controller across concurrent sends", async () => {
    const load = vi.fn(() => import("./submission-controller"));
    const command = vi.fn((text: string) => async () => ({ accepted: false as const, message: text }));
    const environment = vi.fn(async () => ({ command } as unknown as SubmissionEnvironment));
    const session = new WorkbenchSession({
      storage: createMemoryStorage(),
      submission: { client: () => undefined, load, environment },
    });
    expect(load).not.toHaveBeenCalled();
    expect(environment).not.toHaveBeenCalled();
    await expect(Promise.all([session.submit({ text: "/one" }), session.submit({ text: "/two" })]))
      .resolves.toEqual([{ accepted: false, message: "/one" }, { accepted: false, message: "/two" }]);
    expect(load).toHaveBeenCalledOnce();
    expect(environment).toHaveBeenCalledOnce();
    await expect(session.submit({ text: "/three" })).resolves.toEqual({ accepted: false, message: "/three" });
    expect(load).toHaveBeenCalledOnce();
    expect(environment).toHaveBeenCalledOnce();
  });

  it("passes a planned message through the session queue port and accepts it after the host", async () => {
    const queueMessage = vi.fn(async () => ({ id: "planned" }));
    const accepted = vi.fn();
    const preparePrompt = vi.fn();
    const session = new WorkbenchSession({
      storage: createMemoryStorage(),
      submission: {
        client: () => ({ queueMessage, preparePrompt }) as unknown as HostClient,
        environment: { command: () => undefined, accepted } as unknown as SubmissionEnvironment,
      },
    });
    session.applySnapshot(snapshot);
    const deliverAt = 1_800_000_000_000;
    await expect(session.submit({ text: "later", delivery: { deliverAt } })).resolves.toEqual({ accepted: true });
    expect(queueMessage).toHaveBeenCalledExactlyOnceWith("previous", "later", [], undefined, deliverAt, expect.objectContaining({ clientTurnId: expect.any(String), clientMessageId: expect.any(String) }));
    expect(accepted).toHaveBeenCalledOnce();
    expect(preparePrompt).not.toHaveBeenCalled();
    expect(session.view.getOptimisticMessages()).toEqual([]);

    queueMessage.mockRejectedValueOnce(new Error("Queue refused"));
    await expect(session.submit({ text: "later again", delivery: { deliverAt } }))
      .resolves.toEqual({ accepted: false, message: "Queue refused" });
    expect(accepted).toHaveBeenCalledOnce();
  });

  it("sends a message meant for a thread the user has left to that thread, leaving the one on screen alone", async () => {
    const preparePrompt = vi.fn(async () => undefined);
    const sendPrompt = vi.fn(async () => {});
    const steer = vi.fn(async () => {});
    const unsettle = vi.fn();
    const session = new WorkbenchSession({
      storage: createMemoryStorage(),
      submission: {
        client: () => ({ preparePrompt, sendPrompt, steer }) as unknown as HostClient,
        environment: { command: () => undefined, unsettle } as unknown as SubmissionEnvironment,
      },
    });
    session.applySnapshot(snapshot);
    await expect(session.submit({ text: "for A", threadId: "A" })).resolves.toEqual({ accepted: true });
    expect(preparePrompt).toHaveBeenCalledWith("for A", "A", undefined);
    expect(sendPrompt).toHaveBeenCalledExactlyOnceWith("for A", [], "A", expect.objectContaining({ clientMessageId: expect.any(String) }), undefined);
    expect(unsettle).toHaveBeenCalledExactlyOnceWith("A");
    session.threads.setThreadRunning("A", true);
    await expect(session.submit({ text: "steer A", threadId: "A", delivery: "steer" })).resolves.toEqual({ accepted: true });
    expect(steer).toHaveBeenCalledExactlyOnceWith("steer A", [], "A", expect.anything(), undefined);
    expect(session.view.getOptimisticMessages()).toEqual([]);
    expect(session.turn.current()).toBeUndefined();
  });

  it("reconciles an existing thread's live echo during its run before any detail arrives", async () => {
    const h = harness();
    h.session.newThread.set(undefined);
    await expect(h.session.submit({ text: "follow-up" })).resolves.toEqual({ accepted: true });
    const optimistic = h.session.view.getOptimisticMessages()[0].message;
    h.session.threads.setThreadRunning("previous", true);
    liveEcho(h.session, "previous", { ...optimistic, id: "persisted-user" });
    expect(h.session.view.getOptimisticMessages()).toEqual([]);
    expect(h.session.view.getTranscript().messages).toMatchObject([{ id: "persisted-user", text: "follow-up" }]);
    expect(h.session.threads.getActivity().isStreaming).toBe(true);
    expect(h.session.turn.current()?.clientMessageId).toBe(optimistic.clientMessageId);
  });

  it("promotes a draft's live echo before reconciling its optimistic row and the late IPC result", async () => {
    const h = harness();
    const submitted = h.session.submit({ text: "first prompt" });
    await vi.waitFor(() => expect(h.newSession).toHaveBeenCalledOnce());
    const optimistic = h.session.view.getOptimisticMessages()[0].message;
    liveEcho(h.session, "created", { ...optimistic, id: "persisted-first" });
    expect(h.session.newThread.current()).toBeUndefined();
    expect(h.session.view.getSnapshot()?.sessionId).toBe("created");
    expect(h.session.view.getOptimisticMessages()).toEqual([]);
    expect(h.session.view.getTranscript().messages).toMatchObject([{ id: "persisted-first" }]);
    expect(h.session.threads.getActivity().isStreaming).toBe(true);
    h.resolve();
    await expect(submitted).resolves.toEqual({ accepted: true });
    expect(h.session.view.getTranscript().messages).toHaveLength(1);
  });

  it("promotes a submitted draft on the host verdict without renderer coordination", async () => {
    const h = harness();
    const submitted = h.session.submit({ text: "first prompt" });
    await vi.waitFor(() => expect(h.newSession).toHaveBeenCalledOnce());
    h.resolve();
    await expect(submitted).resolves.toEqual({ accepted: true });
    expect(h.session.newThread.current()?.draftId).toBe("sending");
    h.session.delivery.settleDelivery(h.identity().clientMessageId, "created", { accepted: true });
    expect(h.session.newThread.current()).toBeUndefined();
    expect(h.session.view.getSnapshot()?.sessionId).toBe("created");
    expect(h.session.scopes.getSnapshot(createDraftKey(draftKey("created"))).draft).toBe("first prompt");
  });

  it("restores a host-refused first prompt alongside edits made after submission", async () => {
    const h = harness();
    const submitted = h.session.submit({ text: "first prompt" });
    await vi.waitFor(() => expect(h.newSession).toHaveBeenCalledOnce());
    h.resolve();
    await submitted;
    h.session.scopes.setDraft(h.scope, "new edits");
    h.session.delivery.settleDelivery(h.identity().clientMessageId, "created", { accepted: false, message: "Runtime refused" });
    expect(h.session.scopes.getSnapshot(h.scope).draft).toBe("first prompt\n\nnew edits");
    expect(h.session.newThread.current()).toMatchObject({ draftId: "sending", sessionId: "created" });
    expect(h.session.delivery.hasRecovery(h.identity().clientMessageId)).toBe(false);
  });

  it("keeps a newer draft and its edits when an earlier send rejects after navigation", async () => {
    const h = harness();
    const submitted = h.session.submit({ text: "first prompt" });
    await vi.waitFor(() => expect(h.newSession).toHaveBeenCalledOnce());
    h.session.delivery.detachPendingDelivery();
    h.session.newThread.begin({ kind: "draft", draftId: "newer", projectPath: "/other", projectName: "Other" });
    const newerScope = createDraftKey(draftKey(undefined, h.session.newThread.current()));
    h.session.scopes.setDraft(newerScope, "newer edits");
    h.reject();
    await expect(submitted).resolves.toEqual({ accepted: false, message: "Refused" });
    expect(h.session.newThread.current()?.draftId).toBe("newer");
    expect(h.session.scopes.getSnapshot(newerScope).draft).toBe("newer edits");
    expect(h.session.scopes.getSnapshot(h.scope).draft).toBe("first prompt");
    expect(h.session.view.getOptimisticMessages()).toEqual([]);
  });

  it("closes a refused send's toast once a later send goes through", async () => {
    const h = harness();
    const refused = h.session.submit({ text: "first prompt" });
    await vi.waitFor(() => expect(h.newSession).toHaveBeenCalledOnce());
    h.reject();
    await expect(refused).resolves.toEqual({ accepted: false, message: "Refused" });
    expect(h.session.view.getNotice()).toEqual({ message: "Refused", level: "error", id: SEND_FAILED_NOTICE });
    h.session.toasts.show({ id: SEND_FAILED_NOTICE, type: "error", description: "Refused" });
    const retried = h.session.submit({ text: "first prompt" });
    await vi.waitFor(() => expect(h.newSession).toHaveBeenCalledTimes(2));
    expect(h.session.toasts.getToasts()).toHaveLength(1);
    h.resolve();
    await expect(retried).resolves.toEqual({ accepted: true });
    expect(h.session.toasts.getToasts()).toEqual([]);
  });

  it("puts a prompt an existing thread's runtime failed after taking it back before what was typed since", async () => {
    const h = harness();
    h.session.newThread.set(undefined);
    await expect(h.session.submit({ text: "follow-up" })).resolves.toEqual({ accepted: true });
    const { clientMessageId } = h.session.view.getOptimisticMessages()[0].message;
    const scope = createDraftKey(draftKey("previous"));
    h.session.scopes.setDraft(scope, "typed since");
    applyHostEvent({ type: "user-message-failed", sessionId: "previous", clientMessageId: clientMessageId!, message: "runtime failed" }, {
      registry: { dispatchWorkbenchEvent: () => {} },
      threadStore: h.session.threads, view: h.session.view, submission: h.session.delivery,
      currentDraftKey: () => undefined,
    } as unknown as HostEventTargets);
    expect(h.session.view.getOptimisticMessages()).toEqual([]);
    expect(h.session.scopes.getSnapshot(scope).draft).toBe("follow-up\n\ntyped since");
  });

  it("promotes a detached accepted send without replacing the draft now on screen", async () => {
    const h = harness();
    const submitted = h.session.submit({ text: "first prompt" });
    await vi.waitFor(() => expect(h.newSession).toHaveBeenCalledOnce());
    h.session.delivery.detachPendingDelivery();
    h.session.newThread.begin({ kind: "draft", draftId: "newer", projectPath: "/other", projectName: "Other" });
    h.resolve();
    await expect(submitted).resolves.toEqual({ accepted: true });
    h.session.delivery.settleDelivery(h.identity().clientMessageId, "created", { accepted: true });
    expect(h.session.newThread.current()?.draftId).toBe("newer");
    expect(h.session.view.getSnapshot()?.sessionId).toBe("previous");
    expect(h.session.scopes.getSnapshot(createDraftKey(draftKey("created"))).draft).toBe("first prompt");
  });
});
