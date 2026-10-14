import { describe, expect, it, vi } from "vitest";
import { AgentSessionControl } from "./agent-session-control.js";
import { ThreadRuntime } from "./thread-runtime.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "./runtime-adapters.js";

function bench() {
  const order: string[] = [];
  let streaming = true;
  let finishAbort!: () => void;
  const abort = vi.fn(() => {
    order.push("abort");
    return new Promise<void>((resolve) => { finishAbort = () => { streaming = false; resolve(); }; });
  });
  const appendMessage = vi.fn(() => { order.push("repair"); });
  const thread = new ThreadRuntime({
    kind: "pi", threadId: "thread", cwd: "/repo", runtimeAdapter: PI_AGENT_RUNTIME_ADAPTER,
    capabilities: { journal: {
      entries: () => [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "bash", arguments: {} }] } }],
      appendMessage,
    } },
    state: () => ({ streaming, idle: !streaming, activeTools: [] }),
    abort,
  } as never);
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => { order.push("controller"); });
  thread.adapterAbortControllers.add(controller);
  const queue = { hold: vi.fn(() => { order.push("hold"); }) };
  const control = new AgentSessionControl({
    activationEpoch: () => 7,
    extensionUi: { cancelFor: vi.fn(() => { order.push("questions"); }) },
    queue,
    threads: () => ({ get: () => ({ runtime: thread }), run: async (_id: string, run: () => Promise<void>) => run() }),
    publication: () => ({ publishDetail: async () => ({}), actionResult: (updates: unknown[]) => ({ updates }) }),
    log: vi.fn(),
  } as never);
  return { control, thread, order, abort, appendMessage, queue, finish: () => finishAbort() };
}

describe("AgentSessionControl turn ownership", () => {
  it("settles questions and holds delivery before aborting, sharing concurrent aborts", async () => {
    const b = bench();
    const first = b.control.abort(b.thread);
    const second = b.control.abort(b.thread);
    expect(second).toBe(first);
    expect(b.order.slice(0, 4)).toEqual(["questions", "controller", "hold", "abort"]);
    expect(b.abort).toHaveBeenCalledTimes(1);
    b.finish();
    await first;
  });

  it("repairs dangling tools only after the runtime has stopped", async () => {
    const b = bench();
    b.thread.tools.set("call", { status: "running" } as never);
    const recovery = b.control.recover(b.thread);
    expect(b.appendMessage).not.toHaveBeenCalled();
    b.finish();
    await recovery;
    expect(b.order.indexOf("repair")).toBeGreaterThan(b.order.indexOf("abort"));
    expect(b.appendMessage).toHaveBeenCalledWith(expect.objectContaining({ role: "toolResult", toolCallId: "call", isError: true }));
    expect(b.thread.tools.size).toBe(0);
    expect(b.queue.hold).toHaveBeenCalledWith("thread");
  });
});
