// @vitest-environment jsdom
import { useCallback, useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiMessage } from "../../shared/contracts";
import type { ThreadDetail, TranscriptPage } from "../../shared/host-protocol";
import { asHostTranscriptCursor, type HostTranscriptCursor } from "../../shared/transcript-cursor";
import { TranscriptHistoryController } from "../../workbench/transcript-history";
import { TranscriptHistoryBoundary } from "./TranscriptHistoryBoundary";

afterEach(cleanup);

const message = (id: string): UiMessage => ({ id, role: "user", text: id, timestamp: 1 });
const cursor = (name: string) => asHostTranscriptCursor(name);

function start(newest: UiMessage[]) {
  const snapshot = {
    cwd: "/p", projectLabel: "main", sessionId: "t", sessionTitle: "t", messages: newest, olderCursor: cursor("p2"), isStreaming: false,
    activeTools: [], allTools: [], models: [], thinkingLevel: "off", thinkingLevels: ["off"], extensionCount: 0,
  } as unknown as HostSnapshot;
  const detail = { sessionId: "t", messages: newest, olderCursor: cursor("p2"), hasMore: true, isStreaming: false, activeTools: [] } as ThreadDetail;
  const controller = new TranscriptHistoryController(snapshot);
  controller.syncSnapshot(snapshot, detail);
  return controller;
}

function mount(controller: TranscriptHistoryController, loadPage: (sessionId: string, at: HostTranscriptCursor) => Promise<TranscriptPage>, initial: UiMessage[]) {
  let loadThrough!: (messageId: string) => Promise<boolean>;
  function Fixture() {
    const messages = useRef(initial);
    const applyPage = useCallback((page: TranscriptPage, request: Parameters<TranscriptHistoryController["applyPage"]>[2]) => {
      const application = controller.applyPage(page, messages.current, request);
      if (!application) return false;
      messages.current = application.messages;
      return true;
    }, []);
    return <TranscriptHistoryBoundary controller={controller} showControl={false} loadPage={loadPage} applyPage={applyPage}>
      {(_reach, _history, through) => { loadThrough = through; return null; }}
    </TranscriptHistoryBoundary>;
  }
  render(<Fixture />);
  return (messageId: string) => act(() => loadThrough(messageId));
}

describe("TranscriptHistoryBoundary: loadThrough", () => {
  it("loads older pages one after another until the message is among them", async () => {
    const pages: Record<string, TranscriptPage> = {
      p2: { sessionId: "t", messages: [message("m3"), message("m4")], olderCursor: cursor("p1"), hasMore: true },
      p1: { sessionId: "t", messages: [message("m1"), message("m2")], olderCursor: cursor("p0"), hasMore: true },
      p0: { sessionId: "t", messages: [message("m0")], hasMore: false },
    };
    const loadPage = vi.fn(async (_session: string, at: HostTranscriptCursor) => pages[at]!);
    const through = mount(start([message("m5")]), loadPage, [message("m5")]);
    expect(await through("m5")).toBe(true);
    expect(loadPage).not.toHaveBeenCalled();
    expect(await through("m2")).toBe(true);
    expect(loadPage.mock.calls.map((call) => call[1])).toEqual(["p2", "p1"]);
  });

  it("answers false when the whole thread is loaded and the message is not in it", async () => {
    const loadPage = vi.fn(async () => ({ sessionId: "t", messages: [message("m4")], hasMore: false }) as TranscriptPage);
    const through = mount(start([message("m5")]), loadPage, [message("m5")]);
    expect(await through("gone")).toBe(false);
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("stops at a page that fails to load", async () => {
    const loadPage = vi.fn(async () => { throw new Error("offline"); });
    const through = mount(start([message("m5")]), loadPage, [message("m5")]);
    expect(await through("m1")).toBe(false);
    expect(loadPage).toHaveBeenCalledTimes(1);
  });
});
