import { describe, expect, it, vi } from "vitest";
import { cleanThreadTitle, lastTurnActivityFromMessages, modelSupportsImageInput, PiHost } from "./pi-host.js";

describe("cleanThreadTitle", () => {
  it("removes Markdown and title-model framing", () => {
    expect(cleanThreadTitle("## **Thread title: `Persist Turn Activity`**\nExtra explanation")).toBe("Persist Turn Activity");
    expect(cleanThreadTitle("Titel: [Sidebar-Namen](https://example.test)."))
      .toBe("Sidebar-Namen");
  });
});

describe("modelSupportsImageInput", () => {
  it("follows the active model input declaration", () => {
    expect(modelSupportsImageInput({ input: ["text", "image"] })).toBe(true);
    expect(modelSupportsImageInput({ input: ["text"] })).toBe(false);
    expect(modelSupportsImageInput(undefined)).toBe(false);
  });
});

describe("PiHost prompt acceptance", () => {
  it("reports SDK preflight acceptance before a later run rejection", async () => {
    let rejectRun!: (error: Error) => void;
    const run = new Promise<void>((_resolve, reject) => { rejectRun = reject; });
    const session = {
      sessionId: "session",
      model: { input: ["text"] },
      isStreaming: false,
      prompt: async (_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
        options?.preflightResult?.(true);
        await run;
      },
    };
    const host = new PiHost("/repo", vi.fn(), {} as never, true, false);
    const internals = host as unknown as {
      threads: { adopt(record: unknown): Promise<void> };
    };
    await internals.threads.adopt({ sessionId: "session", cwd: "/repo", runtime: { session, sessionId: "session", cwd: "/repo" }, isolation: "in-process" });
    const accepted = vi.fn();
    const prompt = host.prompt("hello", [], "session", accepted);

    await vi.waitFor(() => expect(accepted).toHaveBeenCalledWith());
    rejectRun(new Error("late runtime failure"));
    await expect(prompt).rejects.toThrow("late runtime failure");
    expect(accepted).toHaveBeenCalledOnce();
  });
});

describe("PiHost.generateThreadTitle", () => {
  it("waits for a new thread's active first run before generating its title", async () => {
    let streaming = true;
    let finishRun!: () => void;
    const runFinished = new Promise<void>((resolve) => { finishRun = resolve; });
    const callOrder: string[] = [];
    const session = {
      sessionId: "session",
      get isStreaming() { return streaming; },
      sessionName: undefined as string | undefined,
      messages: [{ role: "user", content: [{ type: "text", text: "Fix automatic titles" }], timestamp: 1 }],
      waitForIdle: async () => {
        callOrder.push("wait");
        await runFinished;
        streaming = false;
      },
      modelRuntime: {
        getModel: () => ({ provider: "provider", id: "model" }),
        completeSimple: async () => {
          callOrder.push("complete");
          return { stopReason: "stop", content: [{ type: "text", text: "Automatic Thread Titles" }] };
        },
      },
      sessionManager: { getBranch: () => [] },
      setSessionName: (title: string) => { session.sessionName = title; },
    };
    const thread = { session, sessionId: "session", cwd: "/repo" };
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as {
      threads: { adopt(record: unknown): Promise<void>; setActive(sessionId: string): void };
      sessions: Array<Record<string, unknown>>;
    };
    await internals.threads.adopt({ sessionId: "session", cwd: "/repo", runtime: thread, isolation: "in-process" });
    internals.threads.setActive("session");
    internals.sessions = [{ id: "session", path: "/session.jsonl", title: "Untitled thread", modifiedAt: 1, projectPath: "/repo", projectName: "repo", messageCount: 1 }];

    const generated = host.generateThreadTitle("provider", "model", false, "session");
    await Promise.resolve();
    expect(callOrder).toEqual(["wait"]);

    finishRun();
    await expect(generated).resolves.toMatchObject({
      updates: [{ type: "thread-shell", update: { sessionId: "session", shell: { title: "Automatic Thread Titles" } } }],
    });
    expect(callOrder).toEqual(["wait", "complete"]);
  });
});

describe("lastTurnActivityFromMessages", () => {
  it("reconstructs completed tools and their transcript anchor", () => {
    const activity = lastTurnActivityFromMessages([
      { role: "user", content: [{ type: "text", text: "older" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "older answer" }], timestamp: 2 },
      { role: "user", content: [{ type: "text", text: "change it" }], timestamp: 3, tauEntryId: "entry-user" },
      { role: "assistant", content: [{ type: "thinking", thinking: "work" }, { type: "toolCall", id: "call", name: "edit", arguments: { path: "/repo/src/a.ts" } }], timestamp: 4 },
      { role: "toolResult", toolCallId: "call", toolName: "edit", content: [{ type: "text", text: "done" }], isError: false, timestamp: 5 },
      { role: "assistant", content: [{ type: "text", text: "finished" }], timestamp: 6 },
    ]);

    expect(activity).toEqual({
      anchorMessageId: "entry-user",
      tools: [{
        id: "call",
        name: "edit",
        args: { path: "/repo/src/a.ts" },
        status: "done",
        output: "done",
        startedAt: 4,
        endedAt: 5,
      }],
    });
  });
});
