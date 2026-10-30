// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { HostSnapshot, UiMessage } from "../shared/contracts";
import type { ThreadDetail, TranscriptPage } from "../shared/host-protocol";
import { asHostTranscriptCursor } from "../shared/transcript-cursor";
import {
  applyTranscriptBundleMerge,
  mergeTranscriptMessages,
  retainsLoadedHistory,
  TranscriptHistoryController,
} from "./transcript-history";

function message(id: string, role: UiMessage["role"] = "user"): UiMessage {
  return { id, role, text: id, timestamp: Number(id.replace(/\D/g, "")) || 1 };
}

function detail(sessionId: string, ids: string[], olderCursor?: string): ThreadDetail {
  return {
    sessionId,
    messages: ids.map((id) => message(id)),
    olderCursor: olderCursor === undefined ? undefined : asHostTranscriptCursor(`opaque:${olderCursor}`),
    hasMore: olderCursor !== undefined,
    isStreaming: false,
    activeTools: [],
  };
}

function snapshot(sessionId: string, ids: string[], olderCursor?: string): HostSnapshot {
  return {
    cwd: "/project",
    projectLabel: "main",
    sessionId,
    sessionTitle: sessionId,
    messages: ids.map((id) => message(id)),
    olderCursor: olderCursor === undefined ? undefined : asHostTranscriptCursor(`opaque:${olderCursor}`),
    isStreaming: false,
    activeTools: [],
    allTools: [],
    models: [],
    thinkingLevel: "off",
    thinkingLevels: ["off"],
    extensionCount: 0,
    };
}

function page(sessionId: string, ids: string[], olderCursor?: string): TranscriptPage {
  return {
    sessionId,
    messages: ids.map((id) => message(id)),
    olderCursor: olderCursor === undefined ? undefined : asHostTranscriptCursor(`opaque:${olderCursor}`),
    hasMore: olderCursor !== undefined,
  };
}

describe("TranscriptHistoryController", () => {
  it("owns detail/page merging and keeps repeated page records unique", () => {
    const controller = new TranscriptHistoryController();
    controller.syncSnapshot(snapshot("thread-a", ["new", "reply"], "2"), detail("thread-a", ["new", "reply"], "2"));

    const request = controller.beginLoad({ messageId: "new", viewportOffset: 120 });
    expect(request).toBeDefined();
    const applied = controller.applyPage(page("thread-a", ["old", "new"], "0"), [message("new"), message("reply")], request);

    expect(applied?.messages.map((item) => item.id)).toEqual(["old", "new", "reply"]);
    expect(controller.getDetail("thread-a")?.messages.map((item) => item.id)).toEqual(["old", "new", "reply"]);
    expect(controller.getSnapshot().olderCursor).toBe(asHostTranscriptCursor("opaque:0"));
    expect(controller.completeSuccess(request!, 1)).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ loading: false, status: { state: "success", loadedTurns: 1 } });
  });

  it("rejects a page when a newer thread transition wins", () => {
    const controller = new TranscriptHistoryController();
    controller.syncSnapshot(snapshot("thread-a", ["a"], "1"), detail("thread-a", ["a"], "1"));
    const request = controller.beginLoad({ messageId: "a", viewportOffset: 0 });
    expect(request).toBeDefined();

    const firstTransition = controller.beginThreadSwitch("thread-b");
    const secondTransition = controller.beginThreadSwitch("thread-c");
    expect(controller.isCurrentThreadTransition(firstTransition)).toBe(false);
    expect(controller.isCurrentThreadTransition(secondTransition)).toBe(true);
    expect(controller.confirmThreadTransition(secondTransition, "thread-b")).toBe(false);
    expect(controller.confirmThreadTransition(secondTransition, "thread-c")).toBe(true);
    expect(controller.applyPage(page("thread-a", ["old-a"], "0"), [], request)).toBeUndefined();
    expect(controller.completeError(request!, "late")).toBe(false);
    expect(controller.applyDetail(detail("thread-b", ["b"]), snapshot("thread-b", ["b"]))).toBeUndefined();

    const applied = controller.applyDetail(detail("thread-c", ["c"]), snapshot("thread-c", ["c"]));
    expect(applied?.detail.sessionId).toBe("thread-c");
    expect(controller.isCurrentThreadTransition(secondTransition)).toBe(false);
  });

  it("does not let an unknown-thread detail through an unresolved switch", () => {
    const controller = new TranscriptHistoryController();
    controller.syncSnapshot(snapshot("thread-a", ["a"]), detail("thread-a", ["a"]));
    controller.beginThreadSwitch();

    expect(controller.applyDetail(detail("thread-b", ["b"]), snapshot("thread-b", ["b"]))).toBeUndefined();
    expect(controller.acceptsDetail("thread-a")).toBe(false);
  });

  it("replaces and cancels an in-flight page after a divergent same-thread refresh", () => {
    const controller = new TranscriptHistoryController();
    const currentIds = ["old", "tail-0", "tail-1"];
    controller.syncSnapshot(snapshot("thread-a", currentIds, "older"), detail("thread-a", currentIds, "older"));
    const request = controller.beginLoad({ messageId: "tail-0", viewportOffset: 80 });
    expect(request).toBeDefined();

    const applied = controller.applyDetail(
      detail("thread-a", ["tail-0", "different-tail"], "newer"),
      snapshot("thread-a", ["tail-0", "different-tail"], "newer"),
    );

    expect(applied?.detail.messages.map((item) => item.id)).toEqual(["tail-0", "different-tail"]);
    expect(controller.isCurrent(request!)).toBe(false);
    expect(controller.getSnapshot()).toMatchObject({ loading: false });
    expect(controller.applyPage(page("thread-a", ["older-page"], "oldest"), [], request)).toBeUndefined();
  });

  it("rejects a bootstrap result that loses a thread transition race", () => {
    const controller = new TranscriptHistoryController(snapshot("thread-a", ["a"], "1"));
    const bootstrap = controller.beginBootstrap();
    controller.beginThreadSwitch("thread-b");

    expect(controller.isCurrentBootstrap(bootstrap)).toBe(false);
    expect(controller.syncSnapshot(snapshot("thread-a", ["stale"]), detail("thread-a", ["stale"]), bootstrap)).toBe(false);
    expect(controller.getCurrentSnapshot()?.messages.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("keeps a bootstrap current through a pushed detail and an older-page request", () => {
    const controller = new TranscriptHistoryController();
    const bootstrap = controller.beginBootstrap();
    controller.applyDetail(detail("running", ["r"], "1"), snapshot("running", ["r"], "1"));
    expect(controller.beginLoad({ messageId: "r", viewportOffset: 0 })).toBeDefined();

    expect(controller.isCurrentBootstrap(bootstrap)).toBe(true);
    expect(controller.syncSnapshot(snapshot("host", ["h"]), detail("host", ["h"]), bootstrap)).toBe(true);
  });

  it("does not cut off a thread switch already under way when a bootstrap starts", () => {
    const controller = new TranscriptHistoryController(snapshot("thread-a", ["a"]));
    const transition = controller.beginThreadSwitch("thread-b");
    const bootstrap = controller.beginBootstrap();

    expect(controller.isCurrentThreadTransition(transition)).toBe(true);
    expect(controller.isCurrentBootstrap(bootstrap)).toBe(false);
    expect(controller.confirmThreadTransition(transition, "thread-b")).toBe(true);
  });

  it("accepts only the newest bootstrap request generation", () => {
    const controller = new TranscriptHistoryController();
    const first = controller.beginBootstrap();
    const second = controller.beginBootstrap();
    expect(controller.isCurrentBootstrap(first)).toBe(false);
    expect(controller.isCurrentBootstrap(second)).toBe(true);
    expect(controller.syncSnapshot(snapshot("thread-b", ["b"]), detail("thread-b", ["b"]), first)).toBe(false);
    expect(controller.syncSnapshot(snapshot("thread-b", ["b"]), detail("thread-b", ["b"]), second)).toBe(true);
  });

  it("keeps the anchor lease after success until explicit user release", () => {
    const controller = new TranscriptHistoryController();
    controller.syncSnapshot(snapshot("thread-a", ["a", "b"], "2"), detail("thread-a", ["a", "b"], "2"));
    const request = controller.beginLoad({ messageId: "b", viewportOffset: 80 });
    expect(request).toBeDefined();
    expect(controller.completeSuccess(request!, 1)).toBe(true);
    expect(controller.anchorRef.current?.messageId).toBe("b");
    expect(controller.preserveScrollRef.current).toBe(true);
    expect(controller.releaseAnchor()).toBe(true);
    expect(controller.anchorRef.current).toBeUndefined();
    expect(controller.preserveScrollRef.current).toBeUndefined();
  });

  it("keeps host-provided activity when an older page arrives", () => {
    const controller = new TranscriptHistoryController();
    const settled = {
      id: "turn-activity-new",
      anchorMessageId: "new",
      status: "completed" as const,
      tools: [{ id: "read", name: "read", args: {}, status: "done" as const, startedAt: 1, endedAt: 2 }],
    };
    controller.syncSnapshot(
      { ...snapshot("thread-a", ["new", "reply"], "2"), turnActivityHistory: [settled] },
      { ...detail("thread-a", ["new", "reply"], "2"), turnActivityHistory: [settled] },
    );
    const request = controller.beginLoad({ messageId: "new", viewportOffset: 80 });

    const applied = controller.applyPage(page("thread-a", ["old"], "0"), [message("new"), message("reply")], request);

    expect(applied?.detail?.turnActivityHistory).toEqual([settled]);
    expect(applied?.snapshot?.turnActivityHistory).toEqual([settled]);
  });

  it("keeps a paging request and its anchor through same-thread detail refreshes", () => {
    const controller = new TranscriptHistoryController();
    controller.syncSnapshot(snapshot("thread-a", ["new", "reply"], "2"), detail("thread-a", ["new", "reply"], "2"));
    const request = controller.beginLoad({ messageId: "new", viewportOffset: 80 });
    expect(request).toBeDefined();
    controller.applyPage(page("thread-a", ["old"], "0"), [message("new"), message("reply")], request);

    expect(controller.applyDetail(detail("thread-a", ["new", "reply"], "2"), snapshot("thread-a", ["new", "reply"], "2"))).toBeDefined();
    expect(controller.isCurrent(request!)).toBe(true);
    expect(controller.anchorRef.current?.messageId).toBe("new");
    expect(controller.completeSuccess(request!, 1)).toBe(true);

    expect(controller.applyDetail(detail("thread-a", ["new", "reply"], "2"), snapshot("thread-a", ["new", "reply"], "2"))).toBeDefined();
    expect(controller.anchorRef.current?.messageId).toBe("new");
    expect(controller.preserveScrollRef.current).toBe(true);
  });

  it("keeps the in-flight request through same-thread lifecycle updates", () => {
    const controller = new TranscriptHistoryController();
    controller.syncSnapshot(snapshot("thread-a", ["new", "reply"], "2"), detail("thread-a", ["new", "reply"], "2"));
    const request = controller.beginLoad({ messageId: "new", viewportOffset: 80 });
    expect(request).toBeDefined();

    const lifecycleDetail: ThreadDetail = {
      ...detail("thread-a", ["new", "reply"], "2"),
      isStreaming: true,
      activeTools: ["model"],
      turnActivity: { tools: [], anchorMessageId: "new" },
    };
    expect(controller.applyDetail(lifecycleDetail, snapshot("thread-a", ["new", "reply"], "2"))).toBeDefined();
    expect(controller.getSnapshot()).toMatchObject({ loading: true, olderCursor: asHostTranscriptCursor("opaque:2") });
    expect(controller.isCurrent(request!)).toBe(true);

    const pageResult = controller.applyPage(page("thread-a", ["old"], "0"), [message("new"), message("reply")], request);
    expect(pageResult).toBeDefined();
    expect(controller.completeSuccess(request!, 1)).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ loading: false, status: { state: "success", loadedTurns: 1 } });
  });

  it("does not invalidate paging when an action returns detail for the visible thread", () => {
    const controller = new TranscriptHistoryController();
    controller.syncSnapshot(snapshot("thread-a", ["new", "reply"], "2"), detail("thread-a", ["new", "reply"], "2"));
    const request = controller.beginLoad({ messageId: "new", viewportOffset: 80 });
    expect(request).toBeDefined();

    expect(controller.prepareActionDetail("thread-a")).toBe(true);
    expect(controller.isCurrent(request!)).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ loading: true });

    expect(controller.applyDetail({
      ...detail("thread-a", ["new", "reply"], "2"),
      isStreaming: true,
    }, snapshot("thread-a", ["new", "reply"], "2"))).toBeDefined();
    expect(controller.isCurrent(request!)).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ loading: true });
    expect(controller.completeSuccess(request!, 1)).toBe(true);
  });

  it("carries a catalog into the merge base so a later detail keeps the thread's model", () => {
    const controller = new TranscriptHistoryController();
    const sol = { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" };
    const luna = { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
    controller.syncSnapshot({ ...snapshot("thread-a", ["ask"]), model: sol, models: [sol, luna] });

    const applied = controller.applyCatalog({
      sessionId: "thread-a",
      models: [sol, luna],
      model: luna,
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      allTools: [],
      extensionCount: 0,
    });
    expect(applied?.model).toEqual(luna);

    // What the host pushes when a turn settles: a detail, and no catalog.
    const settled = controller.applyDetail(
      { ...detail("thread-a", ["ask", "reply"]), isStreaming: false },
      controller.getCurrentSnapshot(),
    );

    expect(settled?.snapshot?.model).toEqual(luna);
    expect(controller.getCurrentSnapshot()?.model).toEqual(luna);
  });

  it("ignores a catalog addressed to another thread", () => {
    const controller = new TranscriptHistoryController();
    const sol = { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" };
    const luna = { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
    controller.syncSnapshot({ ...snapshot("thread-a", ["ask"]), model: sol, models: [sol, luna] });

    expect(controller.applyCatalog({
      sessionId: "thread-b",
      models: [sol, luna],
      model: luna,
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      allTools: [],
      extensionCount: 0,
    })).toBeUndefined();
    expect(controller.getCurrentSnapshot()?.model).toEqual(sol);
  });

  it.each([
    ["equal", ["tail-0", "tail-1", "tail-2", "tail-3"]],
    ["longer", ["tail-0", "tail-1", "tail-2", "tail-3", "tail-4"]],
  ])("preserves an older prefix when an overlapping %s detail refresh updates its tail", (_label, incomingIds) => {
    const controller = new TranscriptHistoryController();
    const currentIds = ["old-0", "old-1", "tail-0", "tail-1", "tail-2", "tail-3"];
    controller.syncSnapshot(
      snapshot("thread-a", currentIds, "older-page"),
      {
        ...detail("thread-a", currentIds, "older-page"),
        cursorBeforeMessageId: "tail-0",
        cursorBoundaries: [{ messageId: "tail-0", cursor: asHostTranscriptCursor("opaque:older-page") }],
      },
    );
    const incoming = {
      ...detail("thread-a", incomingIds, "newer-page"),
      messages: incomingIds.map((id) => ({ ...message(id), text: id === "tail-2" ? "updated tail" : id })),
    };

    const applied = controller.applyDetail(incoming);

    expect(applied?.detail.messages.map((item) => item.id)).toEqual([...currentIds, ...(incomingIds.includes("tail-4") ? ["tail-4"] : [])]);
    expect(applied?.detail.messages.find((item) => item.id === "tail-2")?.text).toBe("updated tail");
    expect(applied?.detail.olderCursor).toBe(asHostTranscriptCursor("opaque:older-page"));
    expect(applied?.detail.cursorBoundaries).toEqual([{
      messageId: "tail-0",
      cursor: asHostTranscriptCursor("opaque:older-page"),
    }]);
  });

  it("retains the newest version when merging a repeated message id", () => {
    const current = [message("old"), message("same", "assistant")];
    const incoming = [{ ...message("same", "assistant"), text: "updated" }, message("new")];
    expect(mergeTranscriptMessages(current, incoming, "prepend")).toEqual([
      message("new"),
      message("old"),
      { ...message("same", "assistant"), text: "updated" },
    ]);
  });

  it("applies one bundle merge policy to messages, activities, and opaque boundaries", () => {
    const merged = applyTranscriptBundleMerge(
      {
        messages: [message("new")],
        taskHistory: [{ id: "task", progress: { tasks: [], completed: 0, total: 0 }, anchorMessageId: "new" }],
        cursorBoundaries: [{ messageId: "new", cursor: asHostTranscriptCursor("opaque:new") }],
      },
      {
        messages: [message("old")],
        taskHistory: [{ id: "task-older", progress: { tasks: [], completed: 0, total: 0 }, anchorMessageId: "old" }],
        cursorBoundaries: [{ messageId: "old", cursor: asHostTranscriptCursor("opaque:old") }],
      },
      "prepend",
    );
    expect(merged.messages.map((item) => item.id)).toEqual(["old", "new"]);
    expect(merged.taskHistory?.map((item) => item.id)).toEqual(["task", "task-older"]);
    expect(merged.cursorBoundaries).toEqual([
      { messageId: "new", cursor: asHostTranscriptCursor("opaque:new") },
      { messageId: "old", cursor: asHostTranscriptCursor("opaque:old") },
    ]);
  });

  it("retains loaded history only for a contiguous current-suffix/incoming-prefix overlap", () => {
    const current = detail("thread-a", ["current-0", "current-1"]);
    expect(retainsLoadedHistory(current, detail("thread-a", ["incoming-0"]))).toBe(false);
    expect(retainsLoadedHistory(current, detail("thread-a", ["current-1", "incoming-0"]))).toBe(true);
    expect(retainsLoadedHistory(
      detail("thread-a", ["old", "tail-0", "tail-1", "tail-2"]),
      detail("thread-a", ["tail-0", "divergent", "tail-2"]),
    )).toBe(false);
    expect(retainsLoadedHistory(
      detail("thread-a", ["old", "tail-0", "tail-1"]),
      detail("thread-a", ["unrelated", "tail-0", "tail-1"]),
    )).toBe(false);
    expect(retainsLoadedHistory(
      detail("thread-a", ["old", "tail-0", "tail-1"]),
      detail("thread-a", ["tail-0", "different-tail"]),
    )).toBe(false);
    expect(retainsLoadedHistory(
      detail("thread-a", ["old", "tail-0", "tail-1"]),
      detail("thread-a", ["tail-0", "tail-1", "new-tail"]),
    )).toBe(true);
  });
});

it("bounds 500 loaded pages while keeping the live tail and reloadable history", () => {
  const controller = new TranscriptHistoryController(snapshot("t", ["tail"], "500"));
  let messages = [message("tail")];
  for (let n = 499; n >= 0; n--) {
    const request = controller.beginLoad()!;
    const result = controller.applyPage(page("t", Array.from({ length: 20 }, (_, i) => `${n}-${i}`), n ? String(n) : undefined), messages, request)!;
    messages = result.messages;
    controller.completeSuccess(request, 20);
  }
  expect(messages.length).toBeLessThanOrEqual(1000);
  expect(messages.some((entry) => entry.id === "0-0")).toBe(true);
  expect(messages.at(-1)?.id).toBe("tail");
  expect(controller.getSnapshot().historyCompleteness).not.toBe("complete");
});

function fillWindow(controller: TranscriptHistoryController, count = 12): UiMessage[] {
  let messages = controller.getDetail("t")!.messages;
  for (let n = count; n > 0; n--) {
    const request = controller.beginLoad()!;
    messages = controller.applyPage({
      ...page("t", [`old-${n}`], String(n)),
      cursorBeforeMessageId: `old-${n}`,
      cursorBoundaries: [{ messageId: `old-${n}`, cursor: asHostTranscriptCursor(`opaque:${n}`) }],
      taskHistory: [{ id: `task-${n}`, anchorMessageId: `old-${n}`, progress: { tasks: [], completed: 0, total: 0 } }],
      turnActivityHistory: [{ id: `activity-${n}`, anchorMessageId: `old-${n}`, tools: [], status: "completed" }],
      turnActivityHistoryComplete: true,
    }, messages, request)!.messages;
    controller.completeSuccess(request, 1);
  }
  return messages;
}

it("evicts page metadata together, preserves live deltas, and reloads discarded history from opaque tail coordinates", () => {
  const controller = new TranscriptHistoryController(snapshot("t", ["tail"], "tail-coordinate"));
  const messages = fillWindow(controller);
  const current = controller.getDetail("t")!;
  expect(current.taskHistory?.some((entry) => entry.id === "task-12")).toBe(false);
  expect(current.turnActivityHistory?.some((entry) => entry.id === "activity-12")).toBe(false);
  expect(current.cursorBoundaries?.some((entry) => entry.messageId === "old-12")).toBe(false);
  expect(controller.getSnapshot().gapBeforeMessageId).toBe("tail");

  const restart = controller.beginRestoreLatest()!;
  const latest = controller.applyPage(restart.page, [...messages, message("stream", "assistant")], restart.request)!;
  expect(latest.messages.map((entry) => entry.id)).toEqual(["tail", "stream"]);
  expect(controller.getSnapshot().gapBeforeMessageId).toBeUndefined();
  controller.completeSuccess(restart.request, 0);
  expect(controller.beginLoad()?.cursor).toBe(asHostTranscriptCursor("opaque:tail-coordinate"));
});

it("keeps a historical anchor and streaming tail through refreshes and rejects a discarded request after restart or switching", () => {
  const controller = new TranscriptHistoryController(snapshot("t", ["tail"], "tail-coordinate"));
  fillWindow(controller);
  const pending = controller.beginLoad({ messageId: "old-1", viewportOffset: 80 })!;
  const updated = { ...detail("t", ["tail", "new-reply"], "new-coordinate"), isStreaming: true };
  const applied = controller.applyDetail(updated)!;
  expect(applied.detail.messages[0]?.id).toBe("old-1");
  expect(applied.detail.messages.at(-1)?.id).toBe("new-reply");
  expect(controller.isCurrent(pending)).toBe(true);
  expect(controller.anchorRef.current?.messageId).toBe("old-1");
  const restart = controller.beginRestoreLatest()!;
  controller.applyPage(restart.page, applied.detail.messages, restart.request);
  expect(controller.applyPage(page("t", ["late"], "late"), [], pending)).toBeUndefined();
  controller.beginThreadSwitch("other");
  controller.applyDetail(detail("other", ["other-tail"], "other-coordinate"));
  expect(controller.applyPage(restart.page, [], restart.request)).toBeUndefined();
  expect(controller.getSnapshot().gapBeforeMessageId).toBeUndefined();
});

it("retains complete oversized records and the preceding page instead of slicing a turn", () => {
  const controller = new TranscriptHistoryController(snapshot("t", ["tail"], "3"));
  let messages = [message("tail")];
  for (let n = 3; n > 0; n--) {
    const request = controller.beginLoad()!;
    const huge = { ...message(`huge-${n}`), text: "x".repeat(5 * 1024 * 1024) };
    messages = controller.applyPage({ ...page("t", [], String(n - 1)), messages: [huge] }, messages, request)!.messages;
    controller.completeSuccess(request, 1);
  }
  expect(messages.map((entry) => entry.id)).toEqual(["huge-1", "huge-2", "tail"]);
  expect(messages[0]?.text.length).toBe(5 * 1024 * 1024);
  expect(controller.getSnapshot().gapBeforeMessageId).toBe("tail");
});

it("bounds message-heavy pages before the page-count limit and caches only a contiguous tail", () => {
  const controller = new TranscriptHistoryController(snapshot("t", ["tail"], "start"));
  let messages = [message("tail")];
  for (let n = 3; n > 0; n--) {
    const request = controller.beginLoad()!;
    messages = controller.applyPage(page("t", Array.from({ length: 400 }, (_, i) => `${n}-${i}`), String(n - 1)), messages, request)!.messages;
    controller.completeSuccess(request, 400);
  }
  expect(messages).toHaveLength(801);
  expect(controller.getCacheSnapshot()?.messages.map((entry) => entry.id)).toEqual(["tail"]);
  controller.beginThreadSwitch("other");
  controller.applyDetail(detail("other", ["other"]));
  expect(controller.getDetail("t")?.messages.map((entry) => entry.id)).toEqual(["tail"]);
});

it("starts a fresh page window when revisiting a cached thread", () => {
  const controller = new TranscriptHistoryController(snapshot("t", ["tail"], "start"));
  fillWindow(controller);
  controller.beginThreadSwitch("other");
  controller.applyDetail(detail("other", ["other-tail"], "other-start"));
  const request = controller.beginLoad()!;
  controller.applyPage(page("other", ["other-history"], "older"), [message("other-tail")], request);
  controller.completeSuccess(request, 1);
  controller.beginThreadSwitch("t");
  const revisited = controller.applyDetail(detail("t", ["tail"], "start"))!;
  expect(revisited.detail.messages.map((entry) => entry.id)).toEqual(["tail"]);
  expect(controller.getSnapshot().gapBeforeMessageId).toBeUndefined();
});

it("keeps gaps reloadable even when the host tail has no visible messages", () => {
  const controller = new TranscriptHistoryController(snapshot("t", [], "start"));
  fillWindow(controller);
  expect(controller.getSnapshot().historyWindowEvicted).toBe(true);
  expect(controller.beginRestoreLatest()?.request.cursor).toBe(asHostTranscriptCursor("opaque:start"));
});

it("waits until the leading source page is visible before scroll paging can evict rows", () => {
  const controller = new TranscriptHistoryController(snapshot("t", ["tail"], "start"));
  fillWindow(controller);
  expect(controller.beginLoad({ messageId: "old-3", viewportOffset: 0 })).toBeUndefined();
  expect(controller.beginLoad({ messageId: "old-1", viewportOffset: 0 })).toBeDefined();
});
