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

  it("invalidates a page when a newer session transition wins", () => {
    const controller = new TranscriptHistoryController();
    controller.syncSnapshot(snapshot("thread-a", ["a"], "1"), detail("thread-a", ["a"], "1"));
    const request = controller.beginLoad({ messageId: "a", viewportOffset: 0 });
    expect(request).toBeDefined();

    const firstTransition = controller.beginSessionSwitch("thread-b");
    const secondTransition = controller.beginSessionSwitch("thread-c");
    expect(controller.isCurrentTransition(firstTransition)).toBe(false);
    expect(controller.isCurrentTransition(secondTransition)).toBe(true);
    expect(controller.confirmTransition(secondTransition, "thread-b")).toBe(false);
    expect(controller.confirmTransition(secondTransition, "thread-c")).toBe(true);
    expect(controller.applyPage(page("thread-a", ["old-a"], "0"), [], request)).toBeUndefined();
    expect(controller.completeError(request!, "late")).toBe(false);
    expect(controller.applyDetail(detail("thread-b", ["b"]), snapshot("thread-b", ["b"]))).toBeUndefined();

    const applied = controller.applyDetail(detail("thread-c", ["c"]), snapshot("thread-c", ["c"]));
    expect(applied?.detail.sessionId).toBe("thread-c");
    expect(controller.isCurrentTransition(secondTransition)).toBe(false);
  });

  it("does not let an unknown-session detail through an unresolved switch", () => {
    const controller = new TranscriptHistoryController();
    controller.syncSnapshot(snapshot("thread-a", ["a"]), detail("thread-a", ["a"]));
    controller.beginSessionSwitch();

    expect(controller.applyDetail(detail("thread-b", ["b"]), snapshot("thread-b", ["b"]))).toBeUndefined();
    expect(controller.acceptsDetail("thread-a")).toBe(false);
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
