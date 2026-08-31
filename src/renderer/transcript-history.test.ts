// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { HostSnapshot, UiMessage } from "../shared/contracts";
import type { ThreadDetail, TranscriptPage } from "../shared/host-protocol";
import {
  mergeTranscriptMessages,
  TranscriptHistoryController,
} from "./transcript-history";

function message(id: string, role: UiMessage["role"] = "user"): UiMessage {
  return { id, role, text: id, timestamp: Number(id.replace(/\D/g, "")) || 1 };
}

function detail(sessionId: string, ids: string[], olderCursor?: string): ThreadDetail {
  return {
    sessionId,
    messages: ids.map((id) => message(id)),
    olderCursor,
    hasMore: olderCursor !== undefined,
    isStreaming: false,
    activeTools: [],
  };
}

function snapshot(sessionId: string, ids: string[], olderCursor?: string): HostSnapshot {
  return {
    cwd: "/project",
    branch: "main",
    sessionId,
    sessionTitle: sessionId,
    messages: ids.map((id) => message(id)),
    olderCursor,
    isStreaming: false,
    activeTools: [],
    allTools: [],
    models: [],
    thinkingLevel: "off",
    thinkingLevels: ["off"],
    extensionCount: 0,
    serviceTier: "standard",
    serviceTierAvailable: false,
  };
}

function page(sessionId: string, ids: string[], olderCursor?: string): TranscriptPage {
  return {
    sessionId,
    messages: ids.map((id) => message(id)),
    olderCursor,
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
    expect(controller.getSnapshot()).toMatchObject({ olderCursor: "0", loading: true });
    expect(controller.completeSuccess(request!, 1)).toBe(true);
    expect(controller.getSnapshot()).toMatchObject({ loading: false, status: { state: "success", loadedTurns: 1 } });
  });

  it("invalidates a page when a newer thread transition wins", () => {
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

  it("rejects a bootstrap result that loses a thread transition race", () => {
    const controller = new TranscriptHistoryController(snapshot("thread-a", ["a"], "1"));
    const bootstrap = controller.beginBootstrap();
    controller.beginThreadSwitch("thread-b");

    expect(controller.isCurrentBootstrap(bootstrap)).toBe(false);
    expect(controller.syncSnapshot(snapshot("thread-a", ["stale"]), detail("thread-a", ["stale"]), bootstrap)).toBe(false);
    expect(controller.getCurrentSnapshot()?.messages.map((message) => message.id)).toEqual(["a"]);
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

  it("retains the newest version when merging a repeated message id", () => {
    const current = [message("old"), message("same", "assistant")];
    const incoming = [{ ...message("same", "assistant"), text: "updated" }, message("new")];
    expect(mergeTranscriptMessages(current, incoming, "prepend")).toEqual([
      message("new"),
      message("old"),
      { ...message("same", "assistant"), text: "updated" },
    ]);
  });
});
