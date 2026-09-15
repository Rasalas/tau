import { describe, expect, it, vi } from "vitest";
import { TurnScopeController } from "./turn-scope";

describe("TurnScopeController", () => {
  it("reads the live navigation scope when a send starts before the next render", () => {
    let scope = "draft:first";
    const turns = new TurnScopeController(() => scope);
    scope = "draft:second";

    turns.set({ turnId: "send-second" });

    expect(turns.current()).toEqual({ turnId: "send-second", scopeKey: "draft:second" });
  });

  it("rejects a late completion or promotion from a superseded send", () => {
    const turns = new TurnScopeController(() => "thread:one");
    turns.set({ turnId: "old" });
    turns.set({ turnId: "new" });
    const marker = turns.current();
    const listener = vi.fn();
    turns.subscribe(listener);

    expect(turns.set(undefined, "old")).toBe(false);
    expect(turns.set({ turnId: "old", scopeKey: "thread:promoted" }, "old")).toBe(false);

    expect(turns.current()).toBe(marker);
    expect(listener).not.toHaveBeenCalled();
    expect(turns.set(undefined, "new")).toBe(true);
    expect(turns.current()).toBeUndefined();
    expect(listener).toHaveBeenCalledOnce();
    expect(turns.set({ turnId: "new" }, "new")).toBe(false);
  });

  it("retains the turn anchor when its draft is promoted to the expected thread", () => {
    let scope = "draft:one";
    const turns = new TurnScopeController(() => scope);
    turns.set({ turnId: "send", clientMessageId: "request" });
    turns.set({
      ...turns.current()!,
      scopeKey: "thread:created",
      sessionId: "created",
      preserveAcrossSessionChange: true,
    }, "send");
    const promoted = turns.current();

    scope = "thread:created";
    turns.commitScope(scope);

    expect(turns.current()).toBe(promoted);
    expect(turns.current()?.clientMessageId).toBe("request");
  });

  it("clears even a preserved anchor when navigating to another thread", () => {
    const turns = new TurnScopeController(() => "draft:one");
    turns.set({ turnId: "send", scopeKey: "thread:created", preserveAcrossSessionChange: true });
    turns.commitScope("thread:created");

    turns.commitScope("thread:other");

    expect(turns.current()).toBeUndefined();
  });

  it("clears an ordinary marker on a scope change even if it already names that scope", () => {
    let scope = "thread:one";
    const turns = new TurnScopeController(() => scope);
    scope = "thread:two";
    turns.set({ turnId: "send" });

    turns.commitScope(scope);

    expect(turns.current()).toBeUndefined();
  });

  it("keeps the marker on repeated commits of the same scope", () => {
    const turns = new TurnScopeController(() => "thread:one");
    turns.set({ turnId: "send" });
    const marker = turns.current();
    const listener = vi.fn();
    turns.subscribe(listener);

    turns.commitScope("thread:one");
    turns.commitScope("thread:one");

    expect(turns.current()).toBe(marker);
    expect(listener).not.toHaveBeenCalled();
  });

  it("publishes synchronous snapshots and releases subscriptions", () => {
    const turns = new TurnScopeController(() => "thread:one");
    const seen: Array<string | undefined> = [];
    const unsubscribe = turns.subscribe(() => seen.push(turns.current()?.turnId));

    turns.set({ turnId: "send" });
    turns.set(undefined, "send");
    turns.set(undefined);
    unsubscribe();
    turns.set({ turnId: "later" });

    expect(seen).toEqual(["send", undefined]);
    expect(turns.current()?.turnId).toBe("later");
  });
});
