import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceCapture, type CaptureDeps } from "./capture.js";
import { DEFAULT_SETTINGS, type EncodedFrame, type EvidenceSettings, type PreviewEvidenceFrame, type ScreenState } from "./protocol.js";
import { EvidenceStore } from "./store.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "tau-evidence-capture-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** A picture's content is its name: the same name, the same pixels; another name, far other ones. */
const shades = new Map<string, number>();
function encode(data: string): Promise<EncodedFrame> {
  const name = Buffer.from(data, "base64").toString();
  if (!shades.has(name)) shades.set(name, (shades.size * 40) % 240);
  const shade = shades.get(name)!;
  return Promise.resolve({
    frame: Buffer.from(`jpeg:${name}`).toString("base64"),
    width: 960,
    height: 600,
    thumb: Buffer.from(`thumb:${name}`).toString("base64"),
    luma: Buffer.from(Array.from({ length: 100 }, () => shade)).toString("base64"),
    lumaWidth: 100,
    lumaHeight: 1,
  });
}

function harness(overrides: Partial<CaptureDeps> = {}) {
  const page = { name: "page-a", secret: false, visible: true, open: true };
  let screen: ScreenState | null = null;
  const screenshots = new Map<number, string>();
  let clock = 1_000;
  let settings: EvidenceSettings = DEFAULT_SETTINGS;
  const changed: string[] = [];
  const store = new EvidenceStore(root);
  const deps: CaptureDeps = {
    store,
    settings: async () => settings,
    preview: async (): Promise<PreviewEvidenceFrame> => {
      if (!page.open) return { skipped: "closed" };
      if (page.secret) return { skipped: "secret" };
      return { data: Buffer.from(page.name).toString("base64"), width: 960, height: 600, url: "http://localhost:5173/", title: page.name, visible: page.visible };
    },
    screenState: async () => screen,
    screenFrame: async (_threadId, seq) => {
      const name = screenshots.get(seq);
      return name && screen?.window ? { seq, data: Buffer.from(name).toString("base64"), mimeType: "image/png", window: screen.window } : null;
    },
    encode,
    cwdOf: () => "/project",
    activeThread: () => "thread",
    changed: (threadId) => { changed.push(threadId); },
    now: () => clock,
    log: () => undefined,
    ...overrides,
  };
  const capture = new EvidenceCapture(deps);
  const frames = async () => (await store.list("thread")).turns.map((turn) => ({ turnId: turn.turnId, endedAt: turn.endedAt, frames: turn.frames.map((frame) => `${frame.trigger}:${frame.caption}`) }));
  return {
    capture,
    store,
    page,
    changed,
    frames,
    tick: (ms: number) => { clock += ms; },
    setSettings: (next: Partial<EvidenceSettings>) => { settings = { ...DEFAULT_SETTINGS, ...next }; },
    drive: (next: ScreenState, seq: number, name: string) => { screen = next; screenshots.set(seq, name); },
  };
}

const tool = (name: string, args: Record<string, unknown> = {}) => ({ id: `call-${name}`, name, args });

describe("EvidenceCapture", () => {
  it("keeps the Preview's before and after of a turn that changed the page, with each action between", async () => {
    const { capture, page, frames, tick } = harness();
    capture.accepted("thread", "t1", { deferBefore: false });
    await capture.prepare("thread", "t1");
    await capture.settled();
    tick(100);
    page.name = "page-b";
    capture.toolEnded("thread", tool("preview_click", { text: "Save" }), "/project");
    await capture.settled();
    tick(100);
    capture.toolEnded("thread", tool("preview_snapshot"), "/project");
    await capture.settled();
    tick(100);
    page.name = "page-c";
    await capture.ended("thread", "t1");
    await capture.settled();

    expect(await frames()).toEqual([{ turnId: "t1", endedAt: 1_300, frames: ["turn-start:When the turn started", "action:Clicked “Save”", "turn-end:When the turn ended"] }]);
  });

  it("keeps nothing of a turn that left the page as it was", async () => {
    const { capture, frames, changed } = harness();
    await capture.prepare("thread", "t1");
    capture.tick();
    await capture.ended("thread", "t1");
    await capture.settled();
    expect(await frames()).toEqual([]);
    expect(changed).toEqual([]);
  });

  it("takes the page only for the thread that drives it or that the user watches, and only while the panel shows", async () => {
    const watched = harness({ activeThread: () => "other" });
    await watched.capture.prepare("thread", "t1");
    await watched.capture.settled();
    watched.page.name = "page-b";
    await watched.capture.ended("thread", "t1");
    await watched.capture.settled();
    expect(await watched.frames()).toEqual([]);

    const hidden = harness();
    hidden.page.visible = false;
    await hidden.capture.prepare("thread", "t1");
    await hidden.capture.settled();
    hidden.page.name = "page-b";
    await hidden.capture.ended("thread", "t1");
    await hidden.capture.settled();
    expect(await hidden.frames()).toEqual([]);
  });

  it("takes nothing while a password has focus, while any thread is paused, or where the project said no", async () => {
    const { capture, page, frames, setSettings } = harness();
    await capture.prepare("thread", "t1");
    await capture.settled();
    page.name = "page-b";
    page.secret = true;
    capture.toolEnded("thread", tool("preview_type", { text: "hunter2" }), "/project");
    await capture.settled();
    expect(await frames()).toEqual([]);

    page.secret = false;
    capture.pause("another-thread", "Signing in");
    capture.toolEnded("thread", tool("preview_click"), "/project");
    await capture.settled();
    expect(await frames()).toEqual([]);
    expect(capture.paused()).toEqual({ "another-thread": "Signing in" });

    capture.resume("another-thread");
    setSettings({ preview: false });
    capture.toolEnded("thread", tool("preview_click"), "/project");
    await capture.settled();
    expect(await frames()).toEqual([]);
  });

  it("keeps each new driver screenshot of the driven window with the input that led to it", async () => {
    const { capture, frames, drive, tick } = harness();
    await capture.prepare("thread", "t1");
    const window = { pid: 42, windowId: 7, app: "TextEdit", title: "notes.txt" };
    tick(10);
    drive({ threadId: "thread", window, frame: { seq: 1, at: 1_010, width: 800, height: 600, mimeType: "image/png", window }, actions: [] }, 1, "window-1");
    capture.toolEnded("thread", tool("computer_use_get_window_state"), "/project");
    await capture.settled();
    tick(10);
    drive({ threadId: "thread", window, frame: { seq: 2, at: 1_030, width: 800, height: 600, mimeType: "image/png", window }, actions: [{ id: "c", kind: "key", at: 1_020, keys: ["cmd", "a"] }] }, 2, "window-2");
    capture.toolEnded("thread", tool("computer_use_get_window_state"), "/project");
    capture.toolEnded("thread", tool("computer_use_get_window_state"), "/project");
    await capture.settled();

    expect((await frames())[0]!.frames).toEqual(["action:Looked at TextEdit", "action:Pressed ⌘A"]);
  });

  it("attaches the agent's own picture with its caption, even of an unchanged page, and says why it could not", async () => {
    const { capture, page, frames } = harness();
    await capture.prepare("thread", "t1");
    expect(await capture.attach("thread", "/project", "before: grey header")).toBe("Attached “before: grey header” from the Preview (960×600).");
    expect(await capture.attach("thread", "/project", "again")).toContain("Attached");
    page.secret = true;
    expect(await capture.attach("thread", "/project", "login", "preview")).toBe("Not attached: a password field has focus in the Preview.");
    capture.pause("thread", "Handed over");
    expect(await capture.attach("thread", "/project", "x")).toBe("Not attached: evidence capture is paused for this thread (Handed over).");
    expect((await frames())[0]!.frames).toEqual(["agent:before: grey header", "agent:again"]);
  });

  it("starts a queued prompt's turn when the one before it settles, and lets a steer join the running turn", async () => {
    const { capture, page, frames, tick } = harness();
    capture.accepted("thread", "t1", { deferBefore: false });
    await capture.prepare("thread", "t1");
    await capture.settled();
    capture.accepted("thread", "steer", { deferBefore: true, expectsInput: false });
    capture.accepted("thread", "t2", { deferBefore: true });
    tick(10);
    page.name = "page-b";
    await capture.ended("thread", "t1");
    await capture.settled();
    tick(10);
    page.name = "page-c";
    capture.toolEnded("thread", tool("preview_click"), "/project");
    await capture.settled();

    expect((await frames()).map((turn) => turn.turnId)).toEqual(["t1", "t2"]);
  });
});
