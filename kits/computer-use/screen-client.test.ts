import { describe, expect, it, vi } from "vitest";
import { SCREEN_EVENT, type ScreenLiveFrame, type ScreenState } from "./protocol.js";
import { createScreenService } from "./screen-client.js";

const state = (threadId: string, updatedAt: number): ScreenState => ({ threadId, actions: [], canBringToFront: false, updatedAt, window: { pid: 1, windowId: 2 } });

function fakeHost(answer: (command: string, input?: unknown) => unknown) {
  let push: ((payload: unknown) => void) | undefined;
  const invoke = vi.fn(async (command: string, input?: unknown) => answer(command, input));
  return {
    host: { invoke, onEvent: (name: string, listener: (payload: unknown) => void) => { if (name === SCREEN_EVENT) push = listener; return () => { push = undefined; }; } },
    invoke,
    push: (payload: unknown) => push?.(payload),
  };
}

/** A pause that waits until the test lets the loop go on, so no test depends on a clock. */
function steps() {
  const waiting: (() => void)[] = [];
  return {
    pause: () => new Promise<void>((resolve) => { waiting.push(resolve); }),
    async next() {
      await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      waiting.shift()!();
    },
  };
}

describe("the renderer's screen service", () => {
  it("keeps the newest state per thread from events and from the host", async () => {
    const fake = fakeHost((command) => command === "screen-state" ? state("b", 5) : null);
    const { service, dispose } = createScreenService(fake.host);
    const heard: string[] = [];
    service.subscribe((next) => heard.push(`${next.threadId}@${next.updatedAt}`));

    fake.push(state("a", 2));
    fake.push(state("a", 1));
    fake.push({ nonsense: true });
    expect(service.state("a")?.updatedAt).toBe(2);
    expect(await service.load("b")).toMatchObject({ threadId: "b" });
    expect(heard).toEqual(["a@2", "b@5"]);

    dispose();
    fake.push(state("c", 1));
    expect(service.state("c")).toBeUndefined();
  });

  it("asks for the next live frame only after the last one, and stops the capture when told", async () => {
    let seq = 0;
    const fake = fakeHost((command) => {
      if (command === "screen-live-start") return "granted";
      if (command === "screen-live-frame") return seq < 2 ? { seq: ++seq, url: "data:image/jpeg;base64,AA", width: 4, height: 3 } satisfies ScreenLiveFrame : { seq, url: "data:", width: 4, height: 3 };
      return undefined;
    });
    const loop = steps();
    const { service } = createScreenService(fake.host, loop.pause);
    const frames: number[] = [];

    const stop = service.live("thread", (frame) => frames.push(frame.seq));
    await loop.next();
    await loop.next();
    await loop.next();
    expect(frames).toEqual([1, 2]);
    stop();
    expect(fake.invoke).toHaveBeenLastCalledWith("screen-live-stop", { threadId: "thread" });
  });

  it("says why a live view could not start or ended by itself", async () => {
    const denied = fakeHost((command) => command === "screen-live-start" ? "denied" : undefined);
    const reasons: string[] = [];
    createScreenService(denied.host).service.live("thread", () => undefined, (reason) => reasons.push(reason));
    await vi.waitFor(() => expect(reasons).toEqual(["denied"]));
    expect(denied.invoke).not.toHaveBeenCalledWith("screen-live-stop", expect.anything());

    const ended = fakeHost((command) => command === "screen-live-start" ? "granted" : command === "screen-live-frame" ? { ended: true } : undefined);
    createScreenService(ended.host).service.live("thread", () => undefined, (reason) => reasons.push(reason));
    await vi.waitFor(() => expect(reasons).toEqual(["denied", "ended"]));
    expect(ended.invoke).toHaveBeenLastCalledWith("screen-live-stop", { threadId: "thread" });
  });
});
