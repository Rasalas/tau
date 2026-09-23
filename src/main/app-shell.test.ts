import { describe, expect, it, vi } from "vitest";
import { QUIT_ANSWER_TIMEOUT_MS, createAppShell } from "./app-shell.js";
import type { WindowShellEvent } from "../shared/window-shell.js";

function shell(options: { page?: boolean } = {}) {
  const published: WindowShellEvent[] = [];
  const timers: Array<{ ms: number; run: () => void; cancelled: boolean }> = [];
  const ports = {
    publish: (event: WindowShellEvent) => published.push(event),
    hasPage: () => options.page ?? true,
    pasteAsText: vi.fn(),
    checkForUpdates: vi.fn(),
    updateReady: vi.fn((): string | undefined => undefined),
    releaseNotes: { pending: vi.fn(async () => ({ version: "0.5.0", items: ["One"], totalItems: 1 })), seen: vi.fn(async () => undefined) },
    schedule: (run: () => void, ms: number) => {
      const timer = { ms, run, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  };
  const fire = () => { for (const timer of timers) if (!timer.cancelled) timer.run(); };
  return { subject: createAppShell(ports), ports, published, timers, fire };
}

const requestIdOf = (event: WindowShellEvent | undefined) => (event?.kind === "quit-requested" ? event.requestId : "");

describe("the question before a quit", () => {
  it("quits at once when no page is there to ask", async () => {
    const { subject, published } = shell({ page: false });
    expect(await subject.confirmQuit()).toBe(true);
    expect(published).toEqual([]);
  });

  it("goes by the page's answer", async () => {
    const { subject, published } = shell();
    const staying = subject.confirmQuit();
    await subject.act({ kind: "answer-quit", requestId: requestIdOf(published[0]), answer: "stay" });
    expect(await staying).toBe(false);
    const quitting = subject.confirmQuit();
    await subject.act({ kind: "answer-quit", requestId: requestIdOf(published[1]), answer: "quit" });
    expect(await quitting).toBe(true);
  });

  it("quits anyway when the page does not answer in time", async () => {
    const { subject, timers, fire } = shell();
    const quitting = subject.confirmQuit();
    expect(timers[0]!.ms).toBe(QUIT_ANSWER_TIMEOUT_MS);
    fire();
    expect(await quitting).toBe(true);
  });

  it("waits as long as the user takes once the page asks", async () => {
    const { subject, published, timers, fire } = shell();
    const quitting = subject.confirmQuit();
    const requestId = requestIdOf(published[0]);
    await subject.act({ kind: "answer-quit", requestId, answer: "asking" });
    expect(timers[0]!.cancelled).toBe(true);
    fire();
    let settled = false;
    void quitting.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await subject.act({ kind: "answer-quit", requestId, answer: "stay" });
    expect(await quitting).toBe(false);
  });

  it("ignores an answer to a question nobody asked", async () => {
    const { subject } = shell();
    await expect(subject.act({ kind: "answer-quit", requestId: "quit-99", answer: "quit" })).resolves.toBeUndefined();
  });
});

describe("what the page asks of the window", () => {
  it("reports a downloaded update and the notes not shown yet", async () => {
    const { subject, ports } = shell();
    ports.updateReady.mockReturnValue("0.6.0");
    expect(await subject.act({ kind: "status" })).toEqual({ updateReady: "0.6.0", releaseNotes: { version: "0.5.0", items: ["One"], totalItems: 1 } });
    await subject.act({ kind: "release-notes-seen", version: "0.5.0" });
    expect(ports.releaseNotes.seen).toHaveBeenCalledWith("0.5.0");
  });

  it("pastes as text and checks for updates on request", async () => {
    const { subject, ports } = shell();
    await subject.act({ kind: "paste-as-text" });
    await subject.act({ kind: "check-for-updates" });
    expect(ports.pasteAsText).toHaveBeenCalledTimes(1);
    expect(ports.checkForUpdates).toHaveBeenCalledTimes(1);
  });
});
