// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostUpdateStatus, PlatformEnvironments, UiEnvironment, UiRuntimeToolsState } from "tau";
import { TestProviders } from "../../src/renderer/test-support/test-providers";
import { buildUpdatePlan, runUpdatePlan } from "./update-plan.js";
import { createUpdatePlanSection } from "./update-plan-section.js";
import { ENVIRONMENTS_EXTENSION_ID, LOCAL_STATE, LOCAL_UPDATE_SELECTED } from "./protocol.js";

afterEach(cleanup);
const status = (patch: Partial<HostUpdateStatus> = {}): HostUpdateStatus => ({ version: "1.0.0", latest: "2.0.0", phase: "available", channel: "stable", automatic: false, installer: "host", devicesMayInstall: true, ...patch });
const tools = (patch: Partial<UiRuntimeToolsState["tools"][number]> = {}): UiRuntimeToolsState => ({ tools: [{ tool: "pi", label: "Pi", kinds: ["pi"], source: "npm", installed: "1.0.0", latest: "2.0.0", update: "update", ...patch }], log: [] });
const machine = (id: string, patch: Partial<UiEnvironment> = {}): UiEnvironment => ({ id, name: id, local: id === "local", status: "connected", threads: [], threadCount: 0, projects: [], update: status(), ...patch });
function fixture(machines = [machine("local", { update: status({ installer: "window" }) }), machine("rex")]) {
  const states = new Map(machines.map((entry) => [entry.id, tools()]));
  const calls: string[] = [];
  const readExtension = vi.fn(async (id: string): Promise<UiRuntimeToolsState> => states.get(id)!);
  const invokeExtension = vi.fn(async (id: string): Promise<UiRuntimeToolsState> => {
    calls.push(`tools:${id}`);
    const next = tools({ installed: "2.0.0" });
    states.set(id, next);
    return next;
  });
  const update = vi.fn(async (id: string): Promise<HostUpdateStatus> => {
    calls.push(`machine:${id}`);
    return status({ phase: id === "local" ? "installing" : "installed" });
  });
  const environments = { getSnapshot: () => ({ environments: machines }), readExtension, invokeExtension, update } as unknown as PlatformEnvironments;
  return { machines, states, calls, readExtension, invokeExtension, update, environments };
}
const changed = () => undefined;

describe("reviewed update plan", () => {
  it("only reads during review and lists tools, remote machines and this app in order", async () => {
    const f = fixture();
    const plan = await buildUpdatePlan(f.environments);
    expect(plan.map((step) => `${step.kind}:${step.machine}`)).toEqual(["tools:local", "tools:rex", "machine:rex", "app:local"]);
    expect(plan[0]?.message).toContain("Pi 1.0.0 → 2.0.0");
    expect(f.readExtension).toHaveBeenCalledWith("rex", ENVIRONMENTS_EXTENSION_ID, LOCAL_STATE);
    expect(f.invokeExtension).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });

  it("lists every machine at once, fills rows as reads settle and drops a machine that does not answer", async () => {
    const f = fixture([machine("local"), machine("slow"), machine("rex")]);
    f.readExtension.mockImplementation((id: string) => id === "slow" ? new Promise<UiRuntimeToolsState>(() => undefined) : Promise.resolve(f.states.get(id)!));
    const lists: string[][] = [];
    const plan = await buildUpdatePlan(f.environments, { timeoutMs: 5, changed: (steps) => lists.push(steps.filter((step) => step.kind === "tools").map((step) => `${step.machine}:${step.state}`)) });
    expect(lists[0]).toEqual(["local:reading", "slow:reading", "rex:reading"]);
    expect(lists.some((list) => list.includes("local:pending") && list.includes("slow:reading"))).toBe(true);
    expect(plan.find((step) => step.kind === "tools" && step.machine === "slow")).toMatchObject({ state: "skipped", message: expect.stringContaining("Review again") });
    expect(plan.find((step) => step.kind === "tools" && step.machine === "rex")?.state).toBe("pending");
    await runUpdatePlan(plan, f.environments, { changed });
    expect(f.update.mock.calls.map(([id]) => id)).toEqual(["rex", "local"]);
  });

  it("shows offline, read-only and owner policy exclusions before starting", async () => {
    const f = fixture([machine("offline", { status: "offline" }), machine("viewer", { readOnly: true }), machine("restricted", { update: status({ devicesMayInstall: false }) })]);
    const plan = await buildUpdatePlan(f.environments);
    expect(plan.filter((step) => step.kind === "machine")).toMatchObject([
      { state: "skipped", message: "Disconnected" }, { state: "skipped", message: "Read only" }, { state: "skipped", message: expect.stringContaining("owner") },
    ]);
    expect(f.readExtension).toHaveBeenCalledTimes(1);
    await runUpdatePlan(plan, f.environments, { changed });
    expect(f.update).not.toHaveBeenCalled();
  });

  it("waits for queued tools and required background work before the next restart", async () => {
    const f = fixture();
    const plan = await buildUpdatePlan(f.environments);
    f.invokeExtension.mockImplementation(async (id) => {
      f.calls.push(`tools:${id}`);
      const state = tools({ state: "waiting" });
      f.states.set(id, state);
      return state;
    });
    f.update.mockImplementation(async (id) => {
      f.calls.push(`machine:${id}`);
      return status({ phase: id === "local" ? "installing" : "waiting", reason: "Waiting for required background work and its results before restarting." });
    });
    const messages: string[] = [];
    let now = 0;
    await runUpdatePlan([...plan].reverse(), f.environments, { changed: () => messages.push(...plan.map((step) => step.message ?? "")), now: () => now,
      pause: async () => {
        now++;
        const current = f.calls.at(-1)!;
        if (current.startsWith("tools:")) f.states.set(current.slice(6), tools({ installed: "2.0.0" }));
        else {
          expect(f.calls).not.toContain("machine:local");
          f.machines[1]!.update = status({ phase: "installed" });
        }
      },
    });
    expect(f.calls).toEqual(["tools:rex", "tools:local", "machine:rex", "machine:local"]);
    expect(messages).toContain("Waiting for running turns before updating tools…");
    expect(messages).toContain("Waiting for required background work and its results before restarting.");
    expect(plan.every((step) => step.state === "done")).toBe(true);
    expect(f.invokeExtension).toHaveBeenCalledWith("local", ENVIRONMENTS_EXTENSION_ID, LOCAL_UPDATE_SELECTED, { kinds: ["pi"] }, { timeoutMs: 120_000 });
  });

  it("reports a completed tool failure and continues with safe machine updates", async () => {
    const f = fixture();
    const plan = await buildUpdatePlan(f.environments);
    f.invokeExtension.mockImplementation(async (id) => {
      f.calls.push(`tools:${id}`);
      return id === "rex" ? { ...tools(), log: [{ at: 1, label: "Pi", action: "update", outcome: "failed", message: "Package manager exited with 1" }] } : tools({ installed: "2.0.0" });
    });
    await runUpdatePlan(plan, f.environments, { changed });
    expect(plan[1]).toMatchObject({ state: "failed", message: expect.stringContaining("Package manager exited with 1") });
    expect(f.calls).toEqual(["tools:local", "tools:rex", "machine:rex", "machine:local"]);
  });

  it("does not restart an uncertain tool update, but still updates another machine", async () => {
    const f = fixture([machine("local"), machine("rex"), machine("other")]);
    const plan = await buildUpdatePlan(f.environments);
    f.invokeExtension.mockImplementation(async (id) => {
      if (id === "rex") throw new Error("Request timed out");
      return tools({ installed: "2.0.0" });
    });
    await runUpdatePlan(plan, f.environments, { changed });
    expect(f.update.mock.calls).toEqual([["other", "install"]]);
    expect(plan.find((step) => step.kind === "machine" && step.machine === "rex")?.state).toBe("skipped");
    expect(plan.at(-1)?.state).toBe("skipped");
    expect(plan.find((step) => step.machine === "rex" && step.kind === "tools")).toMatchObject({ state: "failed", message: "Request timed out" });
  });

  it("continues after a machine reports failure and keeps this app last", async () => {
    const f = fixture([machine("local"), machine("bad"), machine("other")]);
    const plan = await buildUpdatePlan(f.environments);
    f.update.mockImplementation(async (id) => {
      f.calls.push(`machine:${id}`);
      return status({ phase: id === "bad" ? "failed" : id === "local" ? "installing" : "installed", reason: "Download failed" });
    });
    await runUpdatePlan(plan, f.environments, { changed });
    expect(plan.find((step) => step.kind === "machine" && step.machine === "bad")).toMatchObject({ state: "failed", message: expect.stringContaining("Download failed") });
    expect(f.calls.slice(-3)).toEqual(["machine:bad", "machine:other", "machine:local"]);
  });

  it("lets an older machine update Tau without falling back to an unselected tools update", async () => {
    const f = fixture();
    const plan = await buildUpdatePlan(f.environments);
    f.invokeExtension.mockRejectedValue(Object.assign(new Error("Missing command"), { code: "unknown-command" }));
    await runUpdatePlan(plan, f.environments, { changed });
    expect(plan[0]).toMatchObject({ state: "failed", message: expect.stringContaining("Update Tau") });
    expect(f.invokeExtension.mock.calls).toHaveLength(2);
    expect(f.calls).toEqual(["machine:rex", "machine:local"]);
  });

  it("waits across a machine reconnect and reports a background-work deferral", async () => {
    const f = fixture();
    const plan = await buildUpdatePlan(f.environments);
    f.update.mockImplementation(async (id) => {
      f.calls.push(`machine:${id}`);
      return status({ phase: id === "local" ? "ready" : "installing", reason: "Required background work is still running; try again later." });
    });
    let polls = 0;
    await runUpdatePlan(plan, f.environments, { changed, pause: async () => {
      polls++;
      f.machines[1]!.status = polls === 1 ? "offline" : "connected";
      if (polls === 2) f.machines[1]!.update = status({ version: "2.0.0", phase: "current" });
    } });
    expect(polls).toBe(2);
    expect(plan[2]?.state).toBe("done");
    expect(plan[3]).toMatchObject({ state: "failed", message: "Required background work is still running; try again later." });
    expect(f.calls.slice(-2)).toEqual(["machine:rex", "machine:local"]);
  });

  it("stops waiting after a deadline without retrying or restarting this app", async () => {
    const f = fixture();
    const plan = await buildUpdatePlan(f.environments);
    f.update.mockResolvedValue(status({ phase: "waiting" }));
    f.machines[1]!.update = status({ phase: "waiting" });
    let now = 0;
    await runUpdatePlan(plan, f.environments, { changed, now: () => now, timeoutMs: 2, pause: async () => { now++; } });
    expect(f.update).toHaveBeenCalledExactlyOnceWith("rex", "install");
    expect(plan[2]).toMatchObject({ state: "failed", message: expect.stringContaining("Still waiting") });
    expect(plan[3]?.state).toBe("skipped");
  });

  it("does not repeat a busy tool request discovered during review", async () => {
    const f = fixture([machine("rex")]);
    f.states.set("rex", tools({ state: "updating" }));
    const plan = await buildUpdatePlan(f.environments);
    await runUpdatePlan(plan, f.environments, { changed, pause: async () => { f.states.set("rex", tools({ installed: "2.0.0" })); } });
    expect(f.invokeExtension).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledOnce();
  });
});

describe("update plan settings", () => {
  it("requires a reviewed list before running and keeps results when Settings remounts", async () => {
    const f = fixture();
    const Section = createUpdatePlanSection(f.environments);
    const view = render(<TestProviders><Section /></TestProviders>);
    expect(screen.queryByRole("button", { name: "Run update plan" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review updates" }));
    await waitFor(() => expect(screen.getAllByText("Pi 1.0.0 → 2.0.0")).toHaveLength(2));
    const run = await screen.findByRole("button", { name: "Run update plan" });
    await waitFor(() => expect(run).toHaveProperty("disabled", false));
    expect(f.update).not.toHaveBeenCalled();
    fireEvent.click(run);
    await waitFor(() => expect(screen.getAllByText("done")).toHaveLength(4));
    expect(f.calls.at(-1)).toBe("machine:local");
    view.unmount();
    render(<TestProviders><Section /></TestProviders>);
    expect(screen.getAllByText("done")).toHaveLength(4);
  });

  it("shows each machine as it answers and enables the run only after every read settled", async () => {
    const f = fixture();
    let answer!: () => void;
    f.readExtension.mockImplementation((id: string) => id === "rex" ? new Promise<UiRuntimeToolsState>((resolve) => { answer = () => resolve(f.states.get(id)!); }) : Promise.resolve(f.states.get(id)!));
    const Section = createUpdatePlanSection(f.environments);
    render(<TestProviders><Section /></TestProviders>);
    fireEvent.click(screen.getByRole("button", { name: "Review updates" }));
    await screen.findByText("Reading agent tools…");
    await screen.findByText("Pi 1.0.0 → 2.0.0");
    expect(screen.getByRole("button", { name: "Run update plan" })).toHaveProperty("disabled", true);
    await act(async () => { answer(); });
    await waitFor(() => expect(screen.getAllByText("Pi 1.0.0 → 2.0.0")).toHaveLength(2));
    expect(screen.queryByText("Reading agent tools…")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Run update plan" })).toHaveProperty("disabled", false));
  });

  it("continues a running plan while Settings is closed and shows its error on return", async () => {
    const f = fixture();
    let reject!: (error: Error) => void;
    f.invokeExtension.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const Section = createUpdatePlanSection(f.environments);
    const view = render(<TestProviders><Section /></TestProviders>);
    fireEvent.click(screen.getByRole("button", { name: "Review updates" }));
    const run = await screen.findByRole("button", { name: "Run update plan" });
    await waitFor(() => expect(run).toHaveProperty("disabled", false));
    fireEvent.click(run);
    await waitFor(() => expect(screen.getByRole("button", { name: "Review updates" })).toHaveProperty("disabled", true));
    await waitFor(() => expect(f.invokeExtension).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => { reject(new Error("Connection lost")); });
    render(<TestProviders><Section /></TestProviders>);
    await screen.findByRole("alert", { name: "" });
    expect(screen.getByText("Connection lost")).toBeTruthy();
    expect(f.update).toHaveBeenCalledExactlyOnceWith("rex", "install");
  });
});
