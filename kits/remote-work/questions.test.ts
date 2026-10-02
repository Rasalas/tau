import { describe, expect, it, vi } from "vitest";
import type { PlatformAttention, PlatformEnvironments, ToastOptions, WorkbenchActions } from "tau";
import type { RemoteThreadLink } from "./protocol.js";
import { QuestionNotices } from "./questions.js";

const link = (patch: Partial<RemoteThreadLink> = {}): RemoteThreadLink => ({
  id: "link-1",
  machine: "host-rex",
  machineName: "rex",
  cwd: "/work/app",
  root: "/work/app",
  title: "Colours",
  thread: "t9",
  status: "running",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});
const waiting = (question: string) => link({ status: "waiting", there: { thread: "t9", state: "waiting", turns: 0, question, updatedAt: 2, epoch: "e", revision: 3 } });

function setup(focused = false, connectedAgents?: (machine: string) => Promise<boolean>) {
  const toasts: ToastOptions[] = [];
  const dismissed: string[] = [];
  const openThread = vi.fn();
  const actions = {
    toast: (options: ToastOptions) => { toasts.push(options); return { id: options.id!, update: vi.fn(), dismiss: () => dismissed.push(options.id!) }; },
    openThread,
    switchSession: vi.fn(async () => true),
    notify: vi.fn(),
  } as unknown as WorkbenchActions;
  let clicked: (outcome: "clicked" | "dismissed") => void = () => undefined;
  const attention = { notify: vi.fn(() => new Promise((resolve) => { clicked = resolve; })), setBadge: vi.fn() } as unknown as PlatformAttention;
  const environments = { open: vi.fn(async () => undefined), watchThread: vi.fn() } as unknown as PlatformEnvironments;
  const notices = new QuestionNotices({ actions: () => actions, attention: () => attention, environments: () => environments, ...(connectedAgents ? { connectedAgents } : {}), focused: () => focused });
  return { notices, toasts, dismissed, openThread, attention, environments, actions, click: (outcome: "clicked" | "dismissed") => clicked(outcome) };
}

describe("a question a thread asks on another machine", () => {
  it("says so here once, with the way to answer there and to look in", async () => {
    const { notices, toasts, openThread, environments, attention, click } = setup();
    notices.update(link());
    notices.update(waiting("Which colour?"));
    notices.update(waiting("Which colour?"));
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ title: "Colours on rex asks", description: "Which colour?", timeoutMs: 0 });
    expect(toasts[0]!.actions!.map((action) => action.label)).toEqual(["Open on rex", "Look in"]);
    toasts[0]!.actions![1]!.run();
    expect(openThread).toHaveBeenCalledWith("t9", { pin: true, machine: "host-rex" });
    toasts[0]!.actions![0]!.run();
    expect(environments.open).toHaveBeenCalledWith("host-rex", { threadId: "t9" });
    expect(attention.notify).toHaveBeenCalledWith({ title: "Colours on rex asks", body: "Which colour?", tag: "tau.remote-work:link-1" });
    click("clicked");
    await vi.waitFor(() => expect(environments.open).toHaveBeenCalledTimes(2));
  });

  it("takes the notice away once the thread moves on, and speaks again for the next question", () => {
    const { notices, toasts, dismissed } = setup(true);
    notices.update(waiting("Which colour?"));
    notices.update(link({ status: "running" }));
    expect(dismissed).toEqual(["remote-work.question:link-1"]);
    notices.update(waiting("Which size?"));
    expect(toasts.map((toast) => toast.description)).toEqual(["Which colour?", "Which size?"]);
  });

  it("stays quiet for a question already waiting when the page loaded, and uses no system notification in a window in front", () => {
    const { notices, toasts, attention } = setup(true);
    notices.seed([waiting("Which colour?")]);
    notices.update(waiting("Which colour?"));
    expect(toasts).toEqual([]);
    notices.update(link({ id: "link-2", status: "waiting", there: { thread: "t8", state: "waiting", turns: 1, question: "Proceed?", updatedAt: 1, epoch: "e", revision: 1 } }));
    expect(toasts).toHaveLength(1);
    expect(attention.notify).not.toHaveBeenCalled();
  });
});


describe("question navigation with an agents connection", () => {
  it("opens toast and notification clicks as proxy threads, preserving remote separators", async () => {
    const connectedAgents = vi.fn(async () => true);
    const { notices, toasts, environments, actions, click } = setup(false, connectedAgents);
    const remote = waiting("Which colour?");
    remote.thread = "saved~thread";
    notices.update(remote);
    toasts[0]!.actions![0]!.run();
    await vi.waitFor(() => expect(actions.switchSession).toHaveBeenCalledWith("tau-thread:machine:host-rex~saved~thread"));
    expect(connectedAgents).toHaveBeenCalledWith("host-rex");
    expect(environments.open).not.toHaveBeenCalled();
    click("clicked");
    await vi.waitFor(() => expect(actions.switchSession).toHaveBeenCalledTimes(2));
    expect(environments.open).not.toHaveBeenCalled();
  });

  it("keeps the moving-window fallback when the agents connection is absent", async () => {
    const { notices, environments, actions } = setup(true, async () => false);
    await notices.openThere(link());
    expect(environments.open).toHaveBeenCalledWith("host-rex", { threadId: "t9" });
    expect(actions.switchSession).not.toHaveBeenCalled();
  });
});
