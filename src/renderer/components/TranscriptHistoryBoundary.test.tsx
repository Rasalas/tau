// @vitest-environment jsdom
import { useCallback, useRef, useState } from "react";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiMessage } from "../../shared/contracts";
import type { ThreadDetail, TranscriptPage } from "../../shared/host-protocol";
import { asHostTranscriptCursor, type HostTranscriptCursor } from "../../shared/transcript-cursor";
import { TranscriptHistoryBoundary } from "./TranscriptHistoryBoundary";
import { VirtualTranscript } from "./VirtualTranscript";
import { TranscriptHistoryController } from "../transcript-history";

type Rect = { x: number; y: number; top: number; left: number; right: number; bottom: number; width: number; height: number; toJSON(): object };

const rect = (top: number, height: number): Rect => ({
  x: 0,
  y: top,
  top,
  left: 0,
  right: 780,
  bottom: top + height,
  width: 780,
  height,
  toJSON: () => ({}),
});

class DeferredResizeObserver {
  static readonly instances = new Set<DeferredResizeObserver>();
  private readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {
    DeferredResizeObserver.instances.add(this);
  }

  observe(element: Element): void { this.observed.add(element); }
  unobserve(element: Element): void { this.observed.delete(element); }
  disconnect(): void {
    this.observed.clear();
    DeferredResizeObserver.instances.delete(this);
  }

  static trigger(): void {
    for (const observer of DeferredResizeObserver.instances) {
      const entries = [...observer.observed].map((target) => ({
        target,
        borderBoxSize: [{ inlineSize: 780, blockSize: (target as HTMLElement).dataset.messageId ? (target as HTMLElement).offsetHeight : 600 }],
      }));
      if (entries.length > 0) observer.callback(entries as unknown as ResizeObserverEntry[], observer as unknown as ResizeObserver);
    }
  }
}

function message(id: string, role: UiMessage["role"] = "user"): UiMessage {
  return { id, role, text: `${id} content`, timestamp: 1 };
}

function snapshot(sessionId: string, messages: UiMessage[]): HostSnapshot {
  return {
    cwd: "/project",
    branch: "main",
    sessionId,
    sessionTitle: sessionId,
    messages,
    olderCursor: asHostTranscriptCursor("opaque:0"),
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

function detail(sessionId: string, messages: UiMessage[]): ThreadDetail {
  return { sessionId, messages, olderCursor: asHostTranscriptCursor("opaque:0"), hasMore: true, isStreaming: false, activeTools: [] };
}

function Fixture({
  controller,
  initialMessages,
  loadPage,
}: {
  controller: TranscriptHistoryController;
  initialMessages: UiMessage[];
  loadPage: (sessionId: string, cursor: HostTranscriptCursor) => Promise<TranscriptPage>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState(initialMessages);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const applyPage = useCallback((page: TranscriptPage, request: Parameters<TranscriptHistoryController["applyPage"]>[2]) => {
    const application = controller.applyPage(page, messagesRef.current, request);
    if (!application) return false;
    setMessages(application.messages);
    return true;
  }, [controller]);

  return <div data-testid="transcript-scroll" ref={scrollRef} style={{ height: 600, overflow: "auto" }}>
    <TranscriptHistoryBoundary
      controller={controller}
      scrollRef={scrollRef}
      showControl
      loadPage={loadPage}
      applyPage={applyPage}
    >
      {(anchorRef) => <VirtualTranscript messages={messages} scrollRef={scrollRef} anchorRef={anchorRef} isStreaming={false} />}
    </TranscriptHistoryBoundary>
  </div>;
}

describe("TranscriptHistoryBoundary integration", () => {
  let restoreLayout: (() => void) | undefined;

  afterEach(() => {
    cleanup();
    restoreLayout?.();
    restoreLayout = undefined;
    DeferredResizeObserver.instances.clear();
    vi.restoreAllMocks();
  });

  it("keeps a visible anchor through delayed variable measurements and ignores growth below it", async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    const originalResizeObserver = window.ResizeObserver;
    const ids = ["before", "anchor", "tail"];
    const actualHeights = new Map([
      ["before", 100],
      ["anchor", 260],
      ["tail", 380],
      ["older-a", 460],
      ["older-b", 90],
    ]);
    // The virtualizer starts from estimates. Real DOM measurements arrive in
    // separate ResizeObserver deliveries, including one after the request has
    // already reported success.
    const measuredHeights = new Map(ids.map((id) => [id, 180]));
    let scrollNode: HTMLElement | undefined;

    Object.defineProperty(window, "ResizeObserver", { configurable: true, value: DeferredResizeObserver });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        const id = this.dataset.messageId;
        if (id) return measuredHeights.get(id) ?? 180;
        return this === scrollNode ? 600 : 0;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      const id = this.dataset.messageId;
      if (id && scrollNode) {
        const transform = this.style.transform.match(/translateY\((-?\d+(?:\.\d+)?)px\)/u);
        const top = Number(transform?.[1] ?? 0) - scrollNode.scrollTop;
        return rect(top, actualHeights.get(id) ?? 180);
      }
      if (this === scrollNode) return rect(0, 600);
      return originalRect.call(this);
    };
    restoreLayout = () => {
      HTMLElement.prototype.getBoundingClientRect = originalRect;
      if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
      else Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
      Object.defineProperty(window, "ResizeObserver", { configurable: true, value: originalResizeObserver });
    };

    const initialMessages = ids.map((id) => message(id));
    const controller = new TranscriptHistoryController(snapshot("thread", initialMessages));
    controller.syncSnapshot(snapshot("thread", initialMessages), detail("thread", initialMessages));
    let resolvePage: ((page: TranscriptPage) => void) | undefined;
    const loadPage = vi.fn(() => new Promise<TranscriptPage>((resolve) => { resolvePage = resolve; }));
    const view = render(<Fixture controller={controller} initialMessages={initialMessages} loadPage={loadPage} />);
    scrollNode = view.getByTestId("transcript-scroll");
    scrollNode.scrollTop = 100;
    const anchorBefore = view.container.querySelector<HTMLElement>('[data-message-id="anchor"]');
    expect(anchorBefore).not.toBeNull();
    const beforeOffset = anchorBefore!.getBoundingClientRect().top - scrollNode.getBoundingClientRect().top;

    fireEvent.click(screen.getByRole("button", { name: "Load older turns" }));
    expect(loadPage).toHaveBeenCalledWith("thread", asHostTranscriptCursor("opaque:0"));
    expect(screen.getByRole("status").textContent).toContain("Loading older turns");

    ids.unshift("older-a", "older-b");
    measuredHeights.set("older-a", 180);
    measuredHeights.set("older-b", 180);
    actualHeights.set("tail", 900);
    await act(async () => {
      resolvePage?.({
        sessionId: "thread",
        messages: [message("older-a"), message("older-b")],
        hasMore: false,
      });
      await Promise.resolve();
    });
    DeferredResizeObserver.trigger();

    await waitFor(() => expect(controller.getSnapshot().status).toMatchObject({ state: "success", loadedTurns: 2 }));
    expect(screen.queryByLabelText("Transcript history")).toBeNull();
    // The initial success used estimates for the newly prepended rows. A later
    // delivery reports their actual, different heights and must still restore
    // the same visible virtualizer anchor.
    measuredHeights.set("older-a", 460);
    measuredHeights.set("older-b", 90);
    measuredHeights.set("tail", 900);
    DeferredResizeObserver.trigger();
    const anchorAfter = view.container.querySelector<HTMLElement>('[data-message-id="anchor"]');
    expect(anchorAfter).not.toBeNull();
    const afterOffset = anchorAfter!.getBoundingClientRect().top - scrollNode.getBoundingClientRect().top;
    expect(Math.abs(afterOffset - beforeOffset)).toBeLessThan(1);
    expect(scrollNode.scrollTop).toBeGreaterThan(400);
    expect(view.container.querySelectorAll(".virtual-transcript-row").length).toBeGreaterThanOrEqual(4);

    const beforeBelowGrowth = scrollNode.scrollTop;
    actualHeights.set("tail", 1_400);
    measuredHeights.set("tail", 1_400);
    DeferredResizeObserver.trigger();
    await waitFor(() => expect(scrollNode.scrollTop).toBe(beforeBelowGrowth));

    // A late image/font/markdown measurement arrives well after the initial
    // success state. The same visible row must remain pinned until the user
    // explicitly interacts with the scroll container.
    const settledOffset = anchorAfter!.getBoundingClientRect().top - scrollNode.getBoundingClientRect().top;
    actualHeights.set("older-a", 720);
    measuredHeights.set("older-a", 720);
    DeferredResizeObserver.trigger();
    await waitFor(() => {
      const lateAnchor = view.container.querySelector<HTMLElement>('[data-message-id="anchor"]');
      expect(lateAnchor).not.toBeNull();
      const lateOffset = lateAnchor!.getBoundingClientRect().top - scrollNode.getBoundingClientRect().top;
      expect(Math.abs(lateOffset - settledOffset)).toBeLessThan(1);
    });
    expect(controller.anchorRef.current?.messageId).toBe("anchor");
    fireEvent.wheel(scrollNode, { deltaY: -120 });
    expect(controller.anchorRef.current).toBeUndefined();
  });
});
