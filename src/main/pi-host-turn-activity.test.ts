import { describe, expect, it } from "vitest";
import { cleanThreadTitle, lastTurnActivityFromMessages, PiHost } from "./pi-host.js";

describe("cleanThreadTitle", () => {
  it("removes Markdown and title-model framing", () => {
    expect(cleanThreadTitle("## **Thread title: `Persist Turn Activity`**\nExtra explanation")).toBe("Persist Turn Activity");
    expect(cleanThreadTitle("Titel: [Sidebar-Namen](https://example.test)."))
      .toBe("Sidebar-Namen");
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
    const backend = {
      kind: "pi" as const,
      runtimeAdapter: { id: "pi" as const, capabilities: { skillInvocationDialect: "pi" as const } },
      threadId: "session",
      providerSessionId: "session",
      sessionId: "session",
      cwd: "/repo",
      isStreaming: () => session.isStreaming,
      isIdle: () => !session.isStreaming,
      waitForIdle: session.waitForIdle,
      sessionName: () => session.sessionName,
      transcript: async () => [{ id: "user", role: "user" as const, text: "Fix automatic titles", timestamp: 1 }],
      completeTitle: async () => session.modelRuntime.completeSimple().then((result) => result.content[0].text),
      setTitle: async (title: string) => { session.setSessionName(title); },
      // The title path does not use the remaining backend operations; these
      // stubs keep this test's runtime-owner seam explicit and typed enough for
      // the host's registry fixture.
      detail: async () => ({ title: session.sessionName }),
    };
    const thread = { backend, runtime: { session }, threadId: "session", sessionId: "session", cwd: "/repo" };
    const host = new PiHost("/repo", () => undefined, {} as never, true, false);
    const internals = host as unknown as {
      threads: { adopt(record: unknown): Promise<void>; setActive(sessionId: string): void };
      sessions: Array<Record<string, unknown>>;
    };
    await internals.threads.adopt({ threadId: "session", cwd: "/repo", runtime: thread, isolation: "in-process" });
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
