import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignInEvent, SignInFlowState, SignInReport } from "../shared/sign-in.js";
import { registerSignIn, type SignInFlowContext, type SignInOptions } from "./sign-in-flows.js";

type Handler = (input?: unknown) => unknown;

function harness(overrides: Partial<SignInOptions> = {}) {
  const commands = new Map<string, Handler>();
  const events: SignInEvent[] = [];
  const flows: SignInFlowContext[] = [];
  let signedIn = false;
  const changed = vi.fn();
  const options: SignInOptions = {
    report: async () => ({
      methods: [
        { id: "browser", label: "Browser", kind: "browser" },
        { id: "key", label: "API key", kind: "api-key", ...(overrides.defaultTarget === "blocked" ? { unavailable: "Set a key first." } : {}) },
      ],
      account: { signedIn, ...(signedIn ? { label: "a@example.com", canSignOut: true } : {}) },
    }),
    signIn: async (_target, method, flow) => {
      flows.push(flow);
      if (method === "key") {
        const key = await flow.ask({ kind: "secret", message: "Paste the key" });
        if (key !== "good") throw new Error("That key was refused.");
        signedIn = true;
        return "Signed in with a key.";
      }
      flow.show({ browser: { url: "http://127.0.0.1:9/consent" } });
      await new Promise<void>((resolve, reject) => flow.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
    signOut: async () => { signedIn = false; return "Signed out."; },
    changed,
    ...overrides,
  };
  const registration = registerSignIn({
    registerCommand: (name, handler) => { commands.set(name, handler as Handler); return () => commands.delete(name); },
    emit: (_name, payload) => events.push(payload as SignInEvent),
  }, options);
  const call = async (name: string, input?: unknown) => commands.get(name)!(input);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { call, events, flows, changed, registration, settle, commands };
}

afterEach(() => { vi.useRealTimers(); });

describe("registerSignIn", () => {
  it("registers the five commands the window drives", () => {
    const { commands } = harness();
    expect([...commands.keys()].sort()).toEqual(["sign-in", "sign-in-cancel", "sign-in-respond", "sign-in-state", "sign-out"]);
  });

  it("asks for a key, takes the answer once and reports the account after the program changed", async () => {
    const { call, events, changed, settle } = harness();
    const started = await call("sign-in", { method: "key" }) as SignInFlowState;
    await settle();
    const asked = events.at(-1)!.flow!;
    expect(asked).toMatchObject({ flowId: started.flowId, phase: "waiting", prompt: { id: "p1", kind: "secret" } });

    await call("sign-in-respond", { flowId: started.flowId, value: "good" });
    await settle();
    await settle();
    expect(changed).toHaveBeenCalledWith("default");
    const last = events.at(-1)!;
    expect(last.report?.account).toMatchObject({ signedIn: true, label: "a@example.com" });
    expect(last.report?.flow).toMatchObject({ phase: "succeeded", message: "Signed in with a key." });
    expect(last.report?.flow?.prompt).toBeUndefined();
    await expect(call("sign-in-respond", { flowId: started.flowId, value: "again" })).rejects.toThrow(/no longer running/u);
  });

  it("fails with the program's reason and leaves the account alone", async () => {
    const { call, events, changed, settle } = harness();
    const started = await call("sign-in", { method: "key" }) as SignInFlowState;
    await settle();
    await call("sign-in-respond", { flowId: started.flowId, value: "bad" });
    await settle();
    await settle();
    expect(changed).not.toHaveBeenCalled();
    expect(events.at(-1)!.report?.flow).toMatchObject({ phase: "failed", message: "That key was refused." });
  });

  it("cancels: the kit's signal aborts and a later answer is refused", async () => {
    const { call, events, flows, settle } = harness();
    const started = await call("sign-in", { method: "browser" }) as SignInFlowState;
    await settle();
    expect(events.at(-1)!.flow).toMatchObject({ phase: "waiting", browser: { url: "http://127.0.0.1:9/consent" } });
    const state = await call("sign-in-cancel", { flowId: started.flowId }) as SignInFlowState;
    expect(state).toMatchObject({ phase: "cancelled", message: "Sign-in cancelled." });
    expect(state.browser).toBeUndefined();
    expect(flows[0]!.signal.aborted).toBe(true);
    await expect(call("sign-in-respond", { flowId: started.flowId, value: "x" })).rejects.toThrow(/no longer running/u);
  });

  it("replaces a running flow with a new one for the same target", async () => {
    const { call, flows, settle } = harness();
    const first = await call("sign-in", { method: "browser" }) as SignInFlowState;
    await settle();
    const second = await call("sign-in", { method: "browser" }) as SignInFlowState;
    expect(second.flowId).not.toBe(first.flowId);
    expect(flows[0]!.signal.aborted).toBe(true);
    const report = await call("sign-in-state") as SignInReport;
    expect(report.flow?.flowId).toBe(second.flowId);
  });

  it("refuses a method the target does not offer or cannot run now", async () => {
    const { call } = harness();
    await expect(call("sign-in", { method: "sso" })).rejects.toThrow(/no sign-in method/u);
    await expect(call("sign-in", {})).rejects.toThrow(/Name the sign-in method/u);
    const blocked = harness({ defaultTarget: "blocked" });
    await expect(blocked.call("sign-in", { method: "key" })).rejects.toThrow("Set a key first.");
  });

  it("gives up after its timeout", async () => {
    vi.useFakeTimers();
    const { call, events, flows } = harness({ timeoutMs: 1_000 });
    await call("sign-in", { method: "browser" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flows[0]!.signal.aborted).toBe(true);
    expect(events.at(-1)!.report?.flow).toMatchObject({ phase: "failed", message: expect.stringMatching(/too long/u) });
  });

  it("signs out, lets the kit recheck and publishes the new report", async () => {
    const { call, events, changed, settle } = harness();
    const started = await call("sign-in", { method: "key" }) as SignInFlowState;
    await settle();
    await call("sign-in-respond", { flowId: started.flowId, value: "good" });
    await settle();
    await settle();
    changed.mockClear();
    const after = await call("sign-out") as SignInReport;
    expect(changed).toHaveBeenCalledOnce();
    expect(after).toMatchObject({ account: { signedIn: false }, note: "Signed out." });
    expect(after.flow).toBeUndefined();
    expect(events.at(-1)!.report?.account?.signedIn).toBe(false);
  });

  it("publishes a target's report when the kit says what it offers changed", async () => {
    const { registration, events } = harness();
    await registration.publish();
    expect(events.at(-1)).toMatchObject({ target: "default", report: { account: { signedIn: false } } });
  });

  it("keeps targets apart", async () => {
    const { call, settle } = harness();
    const one = await call("sign-in", { target: "work", method: "browser" }) as SignInFlowState;
    await settle();
    await call("sign-in", { target: "home", method: "browser" });
    const work = await call("sign-in-state", { target: "work" }) as SignInReport;
    expect(work.flow).toMatchObject({ flowId: one.flowId, phase: "waiting" });
  });
});
