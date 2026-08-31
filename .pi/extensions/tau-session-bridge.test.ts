import { describe, expect, it, vi } from "vitest";
import tauSessionBridge, {
  bridgeNewSessionCommand,
  createNewSessionRequestTracker,
  PI_BRIDGE_SUPPORTS_IMAGE_INPUT,
} from "./tau-session-bridge.js";
import { createNewThreadRequestId } from "../../src/shared/contracts.js";

describe("Tau Pi bridge capability", () => {
  it("declares that the bridge cannot send image prompt input", () => {
    expect(PI_BRIDGE_SUPPORTS_IMAGE_INPUT).toBe(false);
  });

  it("keeps a ready request token until the exact host acknowledgement", () => {
    const tracker = createNewSessionRequestTracker();
    const requestId = createNewThreadRequestId("request-lifecycle");
    const foreignId = createNewThreadRequestId("request-foreign");
    const sessionId = "session-new";
    const bridgeEpoch = "epoch-new";

    tracker.begin(requestId);
    expect(tracker.requestIdForSnapshot()).toBe(requestId);
    expect(tracker.acknowledge(requestId, sessionId, bridgeEpoch)).toBe(false);
    expect(tracker.requestIdForSnapshot()).toBe(requestId);
    tracker.markReady(requestId, sessionId, bridgeEpoch);
    expect(tracker.requestIdForSnapshot()).toBe(requestId);
    expect(tracker.acknowledge(foreignId, sessionId, bridgeEpoch)).toBe(false);
    expect(tracker.acknowledge(requestId, sessionId, "stale-epoch")).toBe(false);
    expect(tracker.requestIdForSnapshot()).toBe(requestId);
    expect(tracker.acknowledge(requestId, sessionId, bridgeEpoch)).toBe(true);
    expect(tracker.requestIdForSnapshot()).toBe(requestId);
    expect(tracker.acknowledge(requestId, sessionId, bridgeEpoch)).toBe(true);
    expect(tracker.acknowledge(requestId, "other-session", bridgeEpoch)).toBe(false);
    tracker.markReady(requestId, sessionId, "reconnected-epoch");
    expect(tracker.acknowledge(requestId, sessionId, "reconnected-epoch")).toBe(true);
    tracker.begin(foreignId);
    expect(tracker.requestIdForSnapshot()).toBe(foreignId);
    expect(tracker.abort(foreignId, sessionId, bridgeEpoch)).toBe(true);
  });

  it("routes session creation through the registered command boundary", () => {
    expect(bridgeNewSessionCommand()).toBe("/tau-bridge-new");
    expect(bridgeNewSessionCommand("hello / world")).toBe(
      `/tau-bridge-new ${Buffer.from(JSON.stringify("hello / world"), "utf8").toString("base64url")}`,
    );
    expect(bridgeNewSessionCommand("hello", createNewThreadRequestId("request-1"))).toBe(
      `/tau-bridge-new ${Buffer.from(JSON.stringify({ initialPrompt: "hello", requestId: "request-1" }), "utf8").toString("base64url")}`,
    );
  });

  it("passes the request token through the registered Pi command handler", async () => {
    const commands = new Map<string, { handler: (args: string, context: unknown) => Promise<void> }>();
    const pi = {
      registerCommand(name: string, command: { handler: (args: string, context: unknown) => Promise<void> }) {
        commands.set(name, command);
      },
      on() {},
    };
    tauSessionBridge(pi as never);
    const requestId = createNewThreadRequestId("request-handler");
    const sendUserMessage = vi.fn();
    const newSession = vi.fn(async (options: { withSession?: (session: { sendUserMessage: typeof sendUserMessage }) => Promise<void> }) => {
      await options.withSession?.({ sendUserMessage });
      return { cancelled: false };
    });
    const handler = commands.get("tau-bridge-new")?.handler;
    expect(handler).toBeDefined();

    await handler!(
      Buffer.from(JSON.stringify({ initialPrompt: "hello", requestId }), "utf8").toString("base64url"),
      { newSession } as never,
    );

    expect(newSession).toHaveBeenCalledOnce();
    expect(sendUserMessage).toHaveBeenCalledWith("hello");
  });
});
