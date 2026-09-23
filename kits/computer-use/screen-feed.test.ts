import { describe, expect, it } from "vitest";
import type { ScreenState } from "./protocol.js";
import { ScreenFeed, imageSize } from "./screen-feed.js";

/** A PNG header that says `width` × `height`; the feed never decodes more. */
function png(width: number, height: number, padding = 0): string {
  const bytes = Buffer.alloc(33 + padding);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString("base64");
}

function jpeg(width: number, height: number): string {
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
  const sof = [0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x00, 0x00, 0x00];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof]).toString("base64");
}

/** What the driver answers for `get_window_state` of the test window: 640×704 points, shot at 1280×1408. */
const windowState = (title = "E24 test window") => ({
  pid: 42,
  screenshot_width: 1280,
  screenshot_height: 1408,
  elements: [
    { element_index: 0, element_token: "s1:0", role: "AXWindow", label: title, frame: { x: 640, y: 30, w: 640, h: 704 } },
    { element_index: 7, element_token: "s1:7", role: "AXButton", label: "Press me", frame: { x: 664, y: 175, w: 100, h: 36 } },
  ],
});

function feed(options: ConstructorParameters<typeof ScreenFeed>[1] = {}) {
  const published: ScreenState[] = [];
  let clock = 1_000;
  const screen = new ScreenFeed((state) => published.push(state), { now: () => clock, ...options });
  return { screen, published, tick: (ms: number) => { clock += ms; } };
}

describe("ScreenFeed", () => {
  it("keeps the window screenshot of a get_window_state call and names the window", () => {
    const { screen, published } = feed({ canBringToFront: () => true });
    screen.toolResult("thread", "computer_use_list_windows", {}, "a", {
      details: { windows: [{ pid: 42, window_id: 7, app_name: "Electron", title: "old title" }, { pid: 9, window_id: 1, app_name: "Mail", title: "Inbox" }] },
    });
    screen.toolCall("thread", "computer_use_get_window_state", { pid: 42, window_id: 7 }, "b");
    screen.toolResult("thread", "computer_use_get_window_state", { pid: 42, window_id: 7 }, "b", {
      content: [{ type: "text", text: "window_id=7" }, { type: "image", data: png(1280, 1408), mimeType: "image/png" }],
      details: windowState(),
    });

    const state = screen.state("thread")!;
    expect(state.window).toEqual({ pid: 42, windowId: 7, app: "Electron", title: "E24 test window" });
    expect(state.frame).toMatchObject({ seq: 1, width: 1280, height: 1408, mimeType: "image/png" });
    expect(state.canBringToFront).toBe(true);
    expect(screen.frame("thread")?.data).toBe(png(1280, 1408));
    expect(published.at(-1)).toEqual(state);
    // Events carry no image data.
    expect(JSON.stringify(published)).not.toContain(png(1280, 1408));
  });

  it("ignores desktop screenshots, zoom crops and tools of other kits", () => {
    const { screen } = feed();
    screen.toolResult("thread", "computer_use_get_desktop_state", {}, "a", { content: [{ type: "image", data: png(2560, 1440) }] });
    screen.toolResult("thread", "computer_use_zoom", { window_id: 7, x1: 0, y1: 0, x2: 10, y2: 10 }, "b", { content: [{ type: "image", data: png(500, 300) }] });
    screen.toolCall("thread", "computer_use_click", { scope: "desktop", x: 5, y: 5 }, "c");
    screen.toolCall("thread", "preview_click", { x: 5, y: 5 }, "d");

    expect(screen.state("thread")).toBeUndefined();
  });

  it("turns calls into actions: pixel clicks, drags, chords, text and element clicks placed on the element", () => {
    const { screen } = feed();
    screen.toolResult("thread", "computer_use_get_window_state", { pid: 42, window_id: 7 }, "s", {
      content: [{ type: "image", data: png(1280, 1408) }],
      details: windowState(),
    });
    screen.toolCall("thread", "computer_use_click", { pid: 42, window_id: 7, x: 147, y: 326 }, "1");
    screen.toolCall("thread", "computer_use_drag", { pid: 42, window_id: 7, from_x: 10, from_y: 20, to_x: 110, to_y: 220 }, "2");
    screen.toolCall("thread", "computer_use_hotkey", { pid: 42, keys: ["cmd", "c"] }, "3");
    screen.toolCall("thread", "computer_use_press_key", { pid: 42, key: "return", modifiers: ["shift"] }, "4");
    screen.toolCall("thread", "computer_use_type_text", { pid: 42, text: "hello e24", x: 300, y: 426 }, "5");
    screen.toolCall("thread", "computer_use_click", { pid: 42, window_id: 7, element_index: 7 }, "6");
    screen.toolCall("thread", "computer_use_click", { pid: 42, window_id: 7, x: 5, y: 5, from_zoom: true }, "7");
    screen.toolCall("thread", "computer_use_scroll", { pid: 42, direction: "down" }, "8");

    const actions = screen.state("thread")!.actions;
    expect(actions.map((action) => action.kind)).toEqual(["click", "drag", "key", "key", "type", "click", "click", "scroll"]);
    expect(actions[0]).toMatchObject({ point: { x: 147, y: 326 }, space: { width: 1280, height: 1408 } });
    expect(actions[1]).toMatchObject({ point: { x: 10, y: 20 }, to: { x: 110, y: 220 } });
    expect(actions[2]!.keys).toEqual(["cmd", "c"]);
    expect(actions[3]!.keys).toEqual(["shift", "return"]);
    expect(actions[4]).toMatchObject({ text: "hello e24", point: { x: 300, y: 426 } });
    // The button's centre, (714, 193) in points, is (148, 326) in the 2× screenshot of a window at (640, 30).
    expect(actions[5]!.point).toEqual({ x: 148, y: 326 });
    expect(actions[6]!.point).toBeUndefined();
    expect(actions[7]).toMatchObject({ direction: "down" });
    expect(actions.slice(0, -1).every((action) => action.status === "done")).toBe(true);
    expect(actions.at(-1)!.status).toBe("running");
  });

  it("settles an action with its result and keeps only the newest", () => {
    const { screen } = feed({ limits: { actions: 2 } });
    screen.toolCall("thread", "computer_use_click", { pid: 1, x: 1, y: 1 }, "a");
    screen.toolCall("thread", "computer_use_click", { pid: 1, x: 2, y: 2 }, "b");
    screen.toolResult("thread", "computer_use_click", { pid: 1, x: 2, y: 2 }, "b", { isError: true });
    screen.toolCall("thread", "computer_use_type_text", { pid: 1, text: "x".repeat(300) }, "c");

    const actions = screen.state("thread")!.actions;
    expect(actions.map((action) => action.id)).toEqual(["b", "c"]);
    expect(actions[0]!.status).toBe("failed");
    expect(actions[1]!.text).toHaveLength(201);
  });

  it("follows the window the agent moves to, and keeps the window id of the same app", () => {
    const { screen } = feed();
    screen.toolCall("thread", "computer_use_get_window_state", { pid: 42, window_id: 7 }, "a");
    screen.toolCall("thread", "computer_use_type_text", { pid: 42, text: "x" }, "b");
    expect(screen.target("thread")).toEqual({ pid: 42, windowId: 7 });
    screen.toolCall("thread", "computer_use_click", { pid: 50, window_id: 3, x: 1, y: 1 }, "c");
    expect(screen.target("thread")).toEqual({ pid: 50, windowId: 3 });
  });

  it("holds a few frames per thread, a few threads, and a byte budget over all of them", () => {
    const { screen } = feed({ limits: { framesPerThread: 2, threads: 2, bytes: 400 } });
    const shot = (thread: string, id: string) => screen.toolResult(thread, "computer_use_get_window_state", { pid: 1, window_id: 1 }, id, {
      content: [{ type: "image", data: png(10, 10, 90) }],
    });
    shot("a", "1");
    shot("a", "2");
    shot("a", "3");
    expect(screen.frame("a", 1)).toBeNull();
    expect(screen.frame("a", 2)?.seq).toBe(2);
    shot("b", "4");
    shot("c", "5");
    expect(screen.state("a")).toBeUndefined();
    shot("c", "6");
    // 164 base64 characters a frame, so two fit: b keeps its only frame, c drops its older one.
    expect(screen.frame("b")?.seq).toBe(4);
    expect(screen.frame("c", 5)).toBeNull();
    expect(screen.frame("c")?.seq).toBe(6);
  });
});

describe("imageSize", () => {
  it("reads PNG and JPEG headers", () => {
    expect(imageSize(png(1280, 1408))).toEqual({ width: 1280, height: 1408 });
    expect(imageSize(jpeg(960, 540))).toEqual({ width: 960, height: 540 });
    expect(imageSize(Buffer.from("not an image").toString("base64"))).toBeUndefined();
  });
});
