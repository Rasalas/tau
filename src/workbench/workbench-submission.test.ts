import { describe, expect, it, vi } from "vitest";
import type { ClientTurnIdentity, HostSnapshot, UiMessage, UiPromptAttachment } from "../shared/contracts";
import { HOST_PROTOCOL_VERSION } from "../shared/host-protocol";
import type { NewThreadResult } from "../shared/host-protocol";
import type { HostClient } from "./host-client";
import type { SubmissionEnvironment } from "./submission-controller";
import { createMemoryStorage } from "./client-storage";
import { createDraftKey } from "./composer-scope-store";
import { draftKey } from "./draft-store";
import { applyHostEvent, type HostEventTargets } from "./host-events";
import { SEND_FAILED_NOTICE } from "./thread-view-store";
import { WorkbenchSession } from "./workbench-session";

const snapshot: HostSnapshot = {
  cwd: "/project", sessionId: "previous", sessionTitle: "Previous", models: [],
  thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0,
  messages: [], isStreaming: false, activeTools: [],
};

function harness() {
  let resolve!: (result: NewThreadResult) => void;
  let reject!: (error: Error) => void;
  let identity!: ClientTurnIdentity;
  const newSession = vi.fn((_text: string, _attachments: UiPromptAttachment[], _workspace: string, turn: ClientTurnIdentity) => {
    identity = turn;
    return new Promise<NewThreadResult>((yes, no) => { resolve = yes; reject = no; });
  });
  const client = {
    preparePrompt: async () => undefined,
    watchNewThread: () => () => {},
    newSession,
    sendPrompt: async () => {},
  } as unknown as HostClient;
  const environment: SubmissionEnvironment = {
    command: () => undefined, claimNewThread: async () => false,
    prepareNewThread: async () => undefined, accepted: () => {}, submitted: async () => {},
    selection: () => ({ runtime: "pi" }), unsettle: () => {}, preview: () => {},
  };
  const session = new WorkbenchSession({ storage: createMemoryStorage(), submission: { client: () => client, environment } });
  session.applySnapshot(snapshot);
  session.newThread.begin({ kind: "draft", draftId: "sending", projectPath: "/project", projectName: "Project" });
  const scope = createDraftKey(draftKey(undefined, session.newThread.current()));
  session.scopes.setDraft(scope, "first prompt");
  return { session, scope, newSession, identity: () => identity, resolve: () => resolve({
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
  it("loads submission on the first command and shares the controller across concurrent sends", async () => {
    const load = vi.fn(() => import("./submission-controller"));
    const command = vi.fn((text: string) => async () => ({ accepted: false as const, message: text }));
    const session = new WorkbenchSession({
      storage: createMemoryStorage(),
      submission: { client: () => undefined, load, environment: { command } as unknown as SubmissionEnvironment },
    });
    expect(load).not.toHaveBeenCalled();
    await expect(Promise.all([session.submit({ text: "/one" }), session.submit({ text: "/two" })]))
      .resolves.toEqual([{ accepted: false, message: "/one" }, { accepted: false, message: "/two" }]);
    expect(load).toHaveBeenCalledOnce();
    await expect(session.submit({ text: "/three" })).resolves.toEqual({ accepted: false, message: "/three" });
    expect(load).toHaveBeenCalledOnce();
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
    expect(queueMessage).toHaveBeenCalledExactlyOnceWith("previous", "later", [], undefined, deliverAt);
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
