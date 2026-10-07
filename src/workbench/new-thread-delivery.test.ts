// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createNewThreadRequestId, type UiMessage } from "../shared/contracts";
import { transcriptNavigationScopeKey, type NewThreadSubmissionRecovery, type TranscriptTurnStart } from "./app-state";
import { createMemoryStorage } from "./client-storage";
import { ComposerScopeStore, createDraftKey } from "./composer-scope-store";
import { draftKey, type NewThreadDraft } from "./draft-store";
import { NewThreadDeliveryCoordinator } from "./new-thread-delivery";
import { ThreadStore } from "./thread-store";
import { ThreadViewStore } from "./thread-view-store";

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

function fixture(options: {
  detached?: boolean;
  notify?: (event: { prompt: string }) => boolean;
  } = {}) {
  const view = new ThreadViewStore();
  const threads = new ThreadStore();
  threads.setActiveThread("old");
  const scopes = new ComposerScopeStore();
  const storage = createMemoryStorage();
  const retainDraftRow = vi.fn();
  const draftScope = createDraftKey(draftKey(undefined, pending));
  scopes.setDraft(draftScope, "first message");
  const state: { pending: NewThreadDraft | undefined; turn: TranscriptTurnStart | undefined } = { pending, turn: undefined };
  const newThread = {
    current: () => state.pending,
    set: (next: NewThreadDraft | undefined) => { state.pending = next; },
    promoteFromUserMessage: (_sessionId: string, projectPath: string) => {
      if (!state.pending || state.pending.projectPath !== projectPath) return undefined;
      const scope = draftKey(undefined, state.pending);
      state.pending = undefined;
      return scope;
    },
  };
  const turn = {
    current: () => state.turn,
    set: (next: TranscriptTurnStart | undefined, expectedTurnId?: string) => {
      if (expectedTurnId !== undefined && state.turn?.turnId !== expectedTurnId) return false;
      state.turn = next;
      return true;
    },
  };
  const order: string[] = [];
  let delivery!: NewThreadDeliveryCoordinator;
  const notifications = vi.fn((event: { prompt: string }) => {
    order.push("notify");
    return options.notify?.(event) ?? true;
  });
  delivery = new NewThreadDeliveryCoordinator({
    projection: { view, threads, scopes, storage, newThread, turn, retainDraftRow },
    notification: { notifyPromptSubmitted: notifications },
  });
  const recovery: NewThreadSubmissionRecovery = {
    pending,
    requestId: createNewThreadRequestId("request-1"),
    scopeRef: scopes.createScopeReference(draftScope),
    draft: message.text,
    attachments: [],
    optimistic: { ...message, id: "local-client-1" },
    ipcPending: true,
    ...(options.detached ? { detached: true } : {}),
  };
  delivery.register(message.clientMessageId!, recovery);
  view.setOptimisticMessages([{ scope: draftScope, message: recovery.optimistic }]);
  state.turn = {
    turnId: "turn-1",
    scope: { kind: "draft", projectPath: pending.projectPath, draftId: pending.draftId },
    clientMessageId: message.clientMessageId,
    text: message.text,
  };
  return { delivery, draftScope, notifications, order, recovery, scopes, state, threads, turn, view, retainDraftRow };
}

describe("NewThreadDeliveryCoordinator", () => {
  it("hands off a detached draft without switching away from another thread", () => {
    const harness = fixture({ detached: true });
    harness.state.pending = undefined;
    const promotion = harness.delivery.promoteRecovery(message.clientMessageId!, "created", message);
    expect(promotion.promoted).toBe(true);
    expect(harness.retainDraftRow).toHaveBeenCalledWith(pending.draftId, "created");
    expect(harness.threads.getSnapshot().activeThreadId).toBe("old");
  });

  it("promotes a submitted draft reopened while its workspace was being prepared", () => {
    const harness = fixture({ detached: true });
    harness.recovery.pending = { ...pending, projectPath: "/worktree" };
    const promotion = harness.delivery.promoteRecovery(message.clientMessageId!, "created", message);
    expect(promotion.promoted).toBe(true);
    expect(promotion.detail?.type).toBe("thread-detail");
    expect(harness.state.pending).toBeUndefined();
  });

  it("returns a detail plan and promotes the turn with its project scope", () => {
    const harness = fixture();

    const promotion = harness.delivery.promoteRecovery(message.clientMessageId!, "created", message);
    expect(promotion.promoted).toBe(true);
    expect(promotion.detail?.type).toBe("thread-detail");
    harness.order.push("detail");
    harness.delivery.finishPromotion(promotion);

    expect(harness.order).toEqual(["detail", "notify"]);
    expect(harness.turn.current()?.scopeKey).toBe(transcriptNavigationScopeKey({ cwd: "/project", sessionId: "created" }));
    expect(harness.view.getOptimisticMessages()[0]?.scope).toBe("session:created");
    expect(harness.state.pending).toBeUndefined();
    expect(harness.delivery.hasRecovery(message.clientMessageId!)).toBe(false);
  });

  it("claims notification before a reentrant notification attempt", () => {
    let delivery: NewThreadDeliveryCoordinator | undefined;
    let activeRecovery: ReturnType<typeof fixture>["recovery"] | undefined;
    const notifications = vi.fn(() => {
      if (activeRecovery) delivery?.notifyPromptSubmitted(pending, "created", message.text, activeRecovery);
      return true;
    });
    const harness = fixture({ notify: () => true });
    delivery = new NewThreadDeliveryCoordinator({
      projection: {
        view: harness.view,
        threads: harness.threads,
        scopes: harness.scopes,
        storage: createMemoryStorage(),
        newThread: {
          current: () => harness.state.pending,
          set: (next) => { harness.state.pending = next; },
          promoteFromUserMessage: () => undefined,
        },
        turn: harness.turn,
      },
      notification: { notifyPromptSubmitted: notifications },
    });
    // This instance needs its own record because scope references belong to a
    // single coordinator lifetime.
    const recovery = {
      ...harness.recovery,
      scopeRef: harness.scopes.createScopeReference(harness.draftScope),
    };
    activeRecovery = recovery;
    delivery.register(message.clientMessageId!, recovery);

    delivery.notifyPromptSubmitted(pending, "created", message.text, recovery);

    expect(notifications).toHaveBeenCalledTimes(1);
  });

  it("rejects stale session reports without releasing the live scope reference", () => {
    const harness = fixture();
    harness.recovery.sessionId = "created";

    expect(harness.delivery.promoteRecovery(message.clientMessageId!, "other", message).promoted).toBe(false);
    expect(harness.delivery.hasRecovery(message.clientMessageId!)).toBe(true);
    expect(harness.recovery.scopeRef.scope).toBe(harness.draftScope);
  });

  it("rehomes detached delivery and restores its scope when the host rejects it", () => {
    const harness = fixture({ detached: true });

    expect(harness.delivery.rehomeDetached(message.clientMessageId!, harness.recovery, "created")).toBeUndefined();
    expect(harness.recovery.scopeRef.scope).toBe(createDraftKey("session:created"));
    expect(harness.view.getOptimisticMessages()[0]?.scope).toBe("session:created");
    harness.delivery.markIpcSettled(message.clientMessageId!, harness.recovery);

    expect(harness.delivery.settleDeliveryPlan(message.clientMessageId!, "created", {
      accepted: false,
      message: "runtime rejected",
    }).handled).toBe(true);
    expect(harness.scopes.getSnapshot(harness.recovery.scopeRef.scope).draft).toContain("first message");
    expect(harness.delivery.hasRecovery(message.clientMessageId!)).toBe(false);
  });
});
