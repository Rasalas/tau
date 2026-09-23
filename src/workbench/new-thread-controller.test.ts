import { describe, expect, it, vi } from "vitest";
import { createMemoryStorage } from "./client-storage";
import { createNewThreadDraft } from "./draft-store";
import { createDraftKey } from "./composer-scope-store";
import type { NewThreadRequestId } from "../shared/contracts";
import { NewThreadController } from "./new-thread-controller";

function project() {
  return { projectPath: "/repo", projectName: "repo", workspaceId: "wk-1" };
}

describe("NewThreadController", () => {
  it("keeps the pending draft readable synchronously before a subscriber renders", () => {
    const storage = createMemoryStorage();
    const controller = new NewThreadController(storage);
    const seen: string[] = [];
    const unsubscribe = controller.subscribe(() => seen.push(controller.current()?.draftId ?? "cleared"));

    const draft = createNewThreadDraft(project());
    controller.begin(draft);

    expect(controller.current()?.projectPath).toBe("/repo");
    expect(controller.current()?.draftId).toBeDefined();
    expect(seen).toEqual([controller.current()?.draftId]);
    expect(storage.keys().length > 0).toBe(true);
    unsubscribe();
  });

  it("persisted drafts are restored on construction", () => {
    const storage = createMemoryStorage();
    const first = new NewThreadController(storage);
    first.begin(createNewThreadDraft(project()));
    const restored = first.current();
    expect(restored).toBeDefined();

    const second = new NewThreadController(storage);
    expect(second.current()?.draftId).toBe(restored?.draftId);
  });

  it("begin issues a fresh request id each time and fills draftId once", () => {
    const storage = createMemoryStorage();
    const controller = new NewThreadController(storage);
    const firstId = controller.requestId();
    const first = createNewThreadDraft(project());
    first.draftId = "already-set";
    controller.begin(first);
    const afterFirstBegin = controller.requestId();
    expect(controller.current()?.draftId).toBe("already-set");
    expect(controller.requestId()).not.toBe(firstId);

    const second = createNewThreadDraft(project());
    const secondId = second.draftId;
    controller.begin(second);
    expect(controller.current()?.draftId).toBe(secondId);
    expect(controller.requestId()).not.toBe(afterFirstBegin);

    // A draft without a draftId gets one exactly once.
    const { draftId: _omitted, ...bare } = createNewThreadDraft(project());
    void _omitted;
    const thirdId = controller.requestId();
    controller.begin(bare as typeof second);
    expect(controller.current()?.draftId).toBeTypeOf("string");
    expect(controller.requestId()).not.toBe(thirdId);

    // invalidate also rotates the id and drops any outstanding promotion.
    const beforeInvalidate = controller.requestId();
    controller.invalidate();
    expect(controller.requestId()).not.toBe(beforeInvalidate);
  });

  it("a stale promotion answer is rejected after begin or invalidate", () => {
    const storage = createMemoryStorage();
    const controller = new NewThreadController(storage);
    controller.begin(createNewThreadDraft(project()));
    const pending = controller.current()!;
    const scope = createDraftKey(`new:${pending.projectPath}:${pending.draftId}`);
    const requestId = controller.requestId();
    expect(controller.markAwaitingPromotion({ pending, scope, requestId })).toBe(true);

    // begin rotates the id; the marked context is now unreachable, because
    // isCurrent no longer matches the fresh controller state.
    controller.begin(createNewThreadDraft(project()));
    expect(controller.promoteFromHostReport("s9", "/repo", requestId)).toBe(false);
  });

  it("invalidating clears an outstanding promotion before a late host report", () => {
    const storage = createMemoryStorage();
    const controller = new NewThreadController(storage);
    controller.begin(createNewThreadDraft(project()));
    const pending = controller.current()!;
    const scope = createDraftKey(`new:${pending.projectPath}:${pending.draftId}`);
    const requestId = controller.requestId();
    expect(controller.markAwaitingPromotion({ pending, scope, requestId })).toBe(true);

    controller.invalidate();
    expect(controller.promoteFromHostReport("s9", "/repo", requestId)).toBe(false);
    expect(controller.promoteFromHostReport("s9", "/repo", controller.requestId())).toBe(false);
    expect(controller.current()?.draftId).toBe(pending.draftId);
  });

  it("set accepts functional updates over the current pending draft", () => {
    const storage = createMemoryStorage();
    const controller = new NewThreadController(storage);
    controller.begin(createNewThreadDraft(project()));

    controller.set((pending) => pending ? { ...pending, draft: "hello" } : undefined);
    expect(controller.current()?.draft).toBe("hello");
  });

  it("setModel uses the optimistic draft while it has no session and resolves the name", async () => {
    const storage = createMemoryStorage();
    const controller = new NewThreadController(storage);
    controller.begin(createNewThreadDraft(project()));

    const fallback = vi.fn();
    await controller.setModel("pre", "model-1", fallback, () => "Fancy Model");
    expect(controller.current()?.model).toMatchObject({ provider: "pre", id: "model-1", name: "Fancy Model" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("keeps a draft's model and level with the runtime they were chosen from", async () => {
    const storage = createMemoryStorage();
    const controller = new NewThreadController(storage);
    controller.begin(createNewThreadDraft(project()));
    await controller.setModel("openai", "gpt-5.6-luna", undefined, undefined, "codex");
    await controller.setThinking("low", undefined, "codex");
    expect(controller.current()).toMatchObject({ model: { id: "gpt-5.6-luna" }, thinkingLevel: "low", selectionRuntime: "codex" });
    // Another model drops a level it may not have; the reload keeps the rest.
    await controller.setModel("openai", "gpt-5.6-sol", undefined, undefined, "codex");
    expect(controller.current()?.thinkingLevel).toBeUndefined();
    expect(new NewThreadController(storage).current()).toMatchObject({ model: { id: "gpt-5.6-sol" }, selectionRuntime: "codex" });
    // A level for Pi does not keep a Codex model, and Pi is the absent runtime.
    await controller.setThinking("high", undefined, "pi");
    expect(controller.current()).toMatchObject({ thinkingLevel: "high" });
    expect(controller.current()?.model).toBeUndefined();
    expect(controller.current()?.selectionRuntime).toBeUndefined();

    const fallback = vi.fn().mockResolvedValue(undefined);
    controller.set({ ...createNewThreadDraft(project()), sessionId: "s1" });
    await controller.setThinking("medium", fallback, "pi");
    expect(fallback).toHaveBeenCalledWith("medium");
  });

  it("setModel falls back once the draft carries a session id", async () => {
    const storage = createMemoryStorage();
    const controller = new NewThreadController(storage);
    controller.set({ ...createNewThreadDraft(project()), sessionId: "s1" });

    const fallback = vi.fn().mockResolvedValue(undefined);
    await controller.setModel("pre", "model-1", fallback);
    expect(fallback).toHaveBeenCalledWith("pre", "model-1");
    expect(controller.current()?.model).toBeUndefined();
  });

  it("promotion from a host report requires the outstanding request id and matching scope", () => {
    const storage = createMemoryStorage();
    const controller = new NewThreadController(storage);
    controller.begin(createNewThreadDraft(project()));
    const pending = controller.current()!;
    const scope = createDraftKey(`new:${pending.projectPath}:${pending.draftId}`);
    const requestId = controller.requestId() as NewThreadRequestId;

    expect(controller.markAwaitingPromotion({ pending, scope, requestId })).toBe(true);
    expect(controller.promoteFromHostReport("s9", "/other/repo", requestId)).toBe(false);

    controller.begin(createNewThreadDraft(project()));
    const pending2 = controller.current()!;
    const scope2 = createDraftKey(`new:${pending2.projectPath}:${pending2.draftId}`);
    const requestId2 = controller.requestId() as NewThreadRequestId;
    expect(controller.markAwaitingPromotion({ pending: pending2, scope: scope2, requestId: requestId2 })).toBe(true);
    expect(controller.promoteFromHostReport("s9", "/repo", requestId)).toBe(false);
    expect(controller.promoteFromHostReport("s9", "/repo", requestId2)).toBe(true);
    expect(controller.current()).toBeUndefined();
  });

  it("promotion from a user message clears awaiting promotion and names the scope", () => {
    const storage = createMemoryStorage();
    const controller = new NewThreadController(storage);
    controller.begin(createNewThreadDraft(project()));
    const pending = controller.current()!;

    const scope = controller.promoteFromUserMessage("s9", "/repo");
    expect(scope).toBe(createDraftKey(`new:${pending.projectPath}:${pending.draftId}`));
    expect(controller.current()).toBeUndefined();
    expect(controller.promoteFromUserMessage("s9", "/repo")).toBeUndefined();
  });

  it("isCurrent requires same request id, scope and draft identity", () => {
    const storage = createMemoryStorage();
    const controller = new NewThreadController(storage);
    controller.begin(createNewThreadDraft(project()));
    const pending = controller.current()!;
    const scope = createDraftKey(`new:${pending.projectPath}:${pending.draftId}`);
    const requestId = controller.requestId();

    expect(controller.isCurrent(pending, scope, requestId)).toBe(true);
    expect(controller.isCurrent(pending, createDraftKey("other"), requestId)).toBe(false);
    expect(controller.isCurrent({ ...pending, projectPath: "/nowhere" }, scope, requestId)).toBe(false);
  });

  it("keeps model, level and mode per runtime while a draft switches back and forth", async () => {
    const storage = createMemoryStorage();
    const controller = new NewThreadController(storage);
    controller.begin(createNewThreadDraft(project()));
    await controller.setModel("openai", "gpt-5.6-luna", undefined, () => "GPT-5.6 Luna", "pi");
    await controller.setThinking("low", undefined, "pi");
    await controller.setMode("plan", async () => undefined);

    controller.switchRuntime("pi", "codex");
    // Codex was never chosen for: no model of Pi's, the mode carried along.
    expect(controller.current()).toMatchObject({ mode: "plan" });
    expect(controller.current()?.model).toBeUndefined();
    await controller.setModel("openai", "gpt-5.6-sol", undefined, () => "GPT-5.6 Sol", "codex");
    await controller.setMode("default", async () => undefined);

    controller.switchRuntime("codex", "pi");
    expect(controller.current()).toMatchObject({ model: { id: "gpt-5.6-luna" }, thinkingLevel: "low", mode: "plan" });
    expect(controller.current()?.selectionRuntime).toBeUndefined();
    controller.switchRuntime("pi", "codex");
    expect(controller.current()).toMatchObject({ model: { id: "gpt-5.6-sol" }, selectionRuntime: "codex", mode: "default" });
    // A reload finds both.
    expect(new NewThreadController(storage).current()?.runtimeSelections?.pi).toEqual({ model: { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }, thinkingLevel: "low", mode: "plan" });
  });

  it("starts the next draft on a model another runtime's thread chose for it", () => {
    const controller = new NewThreadController(createMemoryStorage());
    controller.carryToNextDraft("codex", { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", billing: "subscription" });
    controller.begin(createNewThreadDraft(project()));
    expect(controller.current()).toMatchObject({ model: { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }, selectionRuntime: "codex" });
    expect(controller.current()?.model).not.toHaveProperty("billing");
    controller.begin(createNewThreadDraft(project()));
    expect(controller.current()?.model).toBeUndefined();
  });
});
