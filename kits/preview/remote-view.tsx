import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import { AppWindow, ArrowLeft, ArrowRight, Bot, CornerDownLeft, Delete, Globe, Monitor, MonitorOff, RotateCw, Send, Smartphone } from "lucide-react";
import { Empty, errorMessage, getClientStorage, READ_ONLY_REASON, tooltipProps, useCommandAllowed, useHostCapabilities, type WorkbenchActions } from "tau";
import { PREVIEW_HOST_EXTENSION_ID, PREVIEW_INPUT_KEYS, type PreviewInput, type PreviewInputKey, type PreviewState, type PreviewViewer } from "./protocol.js";
import type { ScreenInput, ScreenInputKey } from "./screen-protocol.js";
import { SCREEN_INPUT_KEYS } from "./screen-protocol.js";
import { activeThread, previewHold, previewView, screenService, useDrivenWindow, windowName, type PreviewView } from "./screen-store.js";
import { isPreviewState, previewKit, previewStore, readPreviewState, usePreviewState } from "./store.js";
import { hostMachineName } from "./machine.js";
import { useLiveFrames, type LiveFrameAnswer, type LiveFrameSource } from "./live-frames.js";
import { screenFrameSource } from "./screen-frames.js";
import { describeViewer, screenTraits, viewerId } from "./viewer.js";

/** The keys a touch keyboard lacks, left to right; the page and the window take the same set. */
const KEY_BAR: Array<{ key: PreviewInputKey & ScreenInputKey; label: string; title: string }> = [
  { key: "Tab", label: "tab", title: "Tab: the next field" },
  { key: "Backspace", label: "⌫", title: "Backspace" },
  { key: "Enter", label: "↵", title: "Enter" },
  { key: "Escape", label: "esc", title: "Escape" },
  { key: "ArrowLeft", label: "←", title: "Left" },
  { key: "ArrowUp", label: "↑", title: "Up" },
  { key: "ArrowDown", label: "↓", title: "Down" },
  { key: "ArrowRight", label: "→", title: "Right" },
];

/** A drag this long is a scroll, not a tap. */
const TAP_SLOP_PX = 8;
const SCROLL_EVERY_MS = 80;

const READ_ONLY_NOTE = "This device is paired Read only: it can watch, not click or type.";

/** How often a view that shows "no display" asks whether a window came. */
export const NO_WINDOW_RECHECK_MS = 5_000;

/** What the stage says when the host's machine has no window to draw the page in. */
export function NoDisplay({ state, machine }: { state: PreviewState; machine: string | undefined }) {
  const name = machine ?? "The host";
  const there = machine ?? "the host's computer";
  return <Empty
    icon={<MonitorOff size={20} />}
    title={`${name} has no display`}
    description={state.noWindow?.displayService
      ? <>The page is drawn in a Tau window on {there}. Run <code>tau service install --display</code> there: Tau then opens one out of sight when a page needs it.</>
      : `The page is drawn in a Tau window on ${there}. Open the Tau app there, and the page shows here.`}
  />;
}

type Input = PreviewInput & ScreenInput;

interface Pointer {
  id: number;
  x: number;
  y: number;
  lastY: number;
  lastX: number;
  scrolling: boolean;
  pending: { dx: number; dy: number };
  sentAt: number;
}

/** The stage's size inside its padding. */
function innerBox(element: HTMLElement): { width: number; height: number } {
  const style = getComputedStyle(element);
  const pad = (value: string) => parseFloat(value) || 0;
  return {
    width: element.clientWidth - pad(style.paddingLeft) - pad(style.paddingRight),
    height: element.clientHeight - pad(style.paddingTop) - pad(style.paddingBottom),
  };
}

/** The stage's inner size, for fitting the picture into it. */
function useStageBox(stage: React.RefObject<HTMLDivElement | null>): { width: number; height: number } | undefined {
  const [box, setBox] = useState<{ width: number; height: number }>();
  useEffect(() => {
    const element = stage.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => {
      const { width, height } = innerBox(element);
      setBox((current) => current && current.width === width && current.height === height ? current : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [stage]);
  return box;
}

/** The largest size of `picture`'s shape that fits `box`. */
export function fit(picture: { width: number; height: number }, box: { width: number; height: number }): { width: number; height: number } | undefined {
  if (picture.width < 1 || picture.height < 1 || box.width < 1 || box.height < 1) return undefined;
  const scale = Math.min(box.width / picture.width, box.height / picture.height);
  return { width: Math.floor(picture.width * scale), height: Math.floor(picture.height * scale) };
}

/** Frames of the page from the Preview's host half; each request says what this device's screen is now. */
function browserSource(viewer: () => PreviewViewer | undefined): LiveFrameSource {
  return async (maxWidth, since) => {
    const current = viewer();
    return await previewKit["live-frame"]({ maxWidth, ...(since ? { since } : {}), ...(current ? { viewer: current } : {}) }) as LiveFrameAnswer;
  };
}

/** Whose screen the page is laid out for, as this device reads it. */
export function layoutOwner(state: PreviewState, id: string): "this" | "fixed" | "host" | "other" {
  if (state.layoutFor?.id === id) return "this";
  if (state.viewport.mode === "fixed") return "fixed";
  return state.layoutFor ? "other" : "host";
}

function LayoutStatus({ state, id, viewer, allowed, onError }: { state: PreviewState; id: string; viewer: () => PreviewViewer | undefined; allowed: boolean; onError(message: string): void }) {
  const owner = layoutOwner(state, id);
  if (owner === "this") {
    const size = `${String(state.layoutFor!.width)}×${String(state.layoutFor!.height)}`;
    return <span className="preview-remote-layout" {...tooltipProps(`The page is laid out for this screen (${size})`)}>
      {state.layoutFor!.touch ? <Smartphone size={12} aria-hidden="true" /> : <Monitor size={12} aria-hidden="true" />}This screen
    </span>;
  }
  if (owner === "fixed" && state.viewport.mode === "fixed") {
    return <span className="preview-remote-layout" {...tooltipProps("The viewport has a fixed size, set in the Preview's menu on the host")}>{`${String(state.viewport.width)}×${String(state.viewport.height)}`}</span>;
  }
  const whose = owner === "other" ? `Laid out for “${state.layoutFor!.name}”` : "Laid out for the host's window";
  const layOut = () => {
    const current = viewer();
    if (!current) return;
    void previewKit.layout({ viewer: current }).then(() => onError(""), (problem: unknown) => onError(errorMessage(problem)));
  };
  return <button
    type="button"
    className="preview-remote-fit"
    disabled={!allowed}
    aria-label={`${whose}. Lay it out for this screen`}
    {...tooltipProps(allowed ? `${whose}. Lay it out for this screen` : READ_ONLY_REASON)}
    onClick={layOut}
  ><Monitor size={12} aria-hidden="true" />Fit this screen</button>;
}
/**
 * The Preview on a device that is not the host's own window — a phone, a
 * browser, a window on another computer. The page (or the window an agent
 * drives) runs on the host; this view shows its frames and, with Full access,
 * sends taps, text and keys back (the user's decision 7). Nothing is fetched
 * while the view is out of sight.
 */
export default function RemotePreview({ active, actions, compact }: { active: boolean; actions: WorkbenchActions; compact: boolean }) {
  const state = usePreviewState();
  const screen = screenService.use();
  const chosen = previewView.use();
  const view: PreviewView = screen ? chosen : "browser";
  const threadId = activeThread.use() ?? actions.activeThread()?.sessionId;
  const { readOnly } = useHostCapabilities();
  const machine = hostMachineName.use();
  const hold = previewHold.use();
  const noWindow = view === "browser" && Boolean(state.noWindow);
  const mayNavigate = useCommandAllowed(PREVIEW_HOST_EXTENSION_ID, "navigate");
  const mayOpen = useCommandAllowed(PREVIEW_HOST_EXTENSION_ID, "open");
  const mayInput = useCommandAllowed(PREVIEW_HOST_EXTENSION_ID, "input");
  const mayLayOut = useCommandAllowed(PREVIEW_HOST_EXTENSION_ID, "layout");
  const id = useMemo(() => viewerId(getClientStorage()), []);
  const described = useRef<PreviewViewer | undefined>(undefined);
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const pointer = useRef<Pointer | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [address, setAddress] = useState(state.url);
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!editing) setAddress(state.url); }, [editing, state.url]);

  // No push says a window arrived there; ask again while this says there is none.
  useEffect(() => {
    if (!noWindow || !active) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void previewKit.state().then((value) => { if (isPreviewState(value)) previewStore.set(readPreviewState(value)); }).catch(() => undefined);
    }, NO_WINDOW_RECHECK_MS);
    return () => clearInterval(timer);
  }, [active, noWindow]);

  // The stage is this device's screen for the page, measured when a request goes out.
  const viewer = useCallback((): PreviewViewer | undefined => {
    const element = stage.current;
    described.current = element ? describeViewer(id, innerBox(element), screenTraits(), described.current) : undefined;
    return described.current;
  }, [id]);
  const pageFrames = useMemo(() => browserSource(viewer), [viewer]);
  const source = useMemo<LiveFrameSource | undefined>(() => {
    if (view === "browser") return state.url && !noWindow ? pageFrames : undefined;
    return screen && threadId ? screenFrameSource(screen, threadId) : undefined;
  }, [noWindow, pageFrames, screen, state.url, threadId, view]);
  const frames = useLiveFrames(source, stage, { active });
  const driven = useDrivenWindow(view === "screen" ? screen : undefined, threadId);
  const box = useStageBox(stage);
  // A new size (turned sideways, a resized window) goes out with the next frame, now.
  const size = box ? `${String(Math.round(box.width))}x${String(Math.round(box.height))}` : "";
  useEffect(() => { if (size) frames.poke(); }, [size]);
  // Leaving the page gives it back to the host's window at once rather than when the host stops hearing from here.
  useEffect(() => {
    if (!active || view !== "browser" || !mayLayOut) return undefined;
    return () => { void previewKit.layout({ release: id }).catch(() => undefined); };
  }, [active, id, mayLayOut, view]);
  // Fitted by hand: an <img> never grows past its own size, and a small frame on a slow link would stay small.
  const fitted = frames.picture && box ? fit(frames.picture, box) : undefined;
  const canDrive = view === "browser" ? mayInput && Boolean(state.url) && !noWindow : !readOnly && Boolean(screen?.input && threadId);

  // A secret field on the page makes this device's own field a password field; switching away forgets it.
  useEffect(() => { setSecret(false); }, [view, state.url]);

  const send = useCallback(async (input: Input): Promise<void> => {
    setError("");
    try {
      if (view === "browser") {
        const result = await previewKit.input(input);
        setSecret(result.focus === "secret");
      } else if (screen?.input && threadId) {
        await screen.input(threadId, input);
      }
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      frames.poke();
    }
  }, [frames, screen, threadId, view]);

  const fractionAt = (clientX: number, clientY: number): { x: number; y: number } | undefined => {
    const rect = image.current?.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) return undefined;
    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    return { x: clamp((clientX - rect.left) / rect.width), y: clamp((clientY - rect.top) / rect.height) };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (!canDrive || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, scrolling: false, pending: { dx: 0, dy: 0 }, sentAt: 0 };
  };
  const flushScroll = (current: Pointer, at: { x: number; y: number }) => {
    const { dx, dy } = current.pending;
    if (dx === 0 && dy === 0) return;
    current.pending = { dx: 0, dy: 0 };
    current.sentAt = Date.now();
    void send({ kind: "scroll", x: at.x, y: at.y, dx, dy });
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    const current = pointer.current;
    const rect = image.current?.getBoundingClientRect();
    if (!current || current.id !== event.pointerId || !rect) return;
    if (!current.scrolling && Math.hypot(event.clientX - current.x, event.clientY - current.y) < TAP_SLOP_PX) return;
    current.scrolling = true;
    // Dragging the picture up scrolls the page down, as a finger on the page would.
    current.pending.dx += (current.lastX - event.clientX) / rect.width;
    current.pending.dy += (current.lastY - event.clientY) / rect.height;
    current.lastX = event.clientX;
    current.lastY = event.clientY;
    const at = fractionAt(current.x, current.y);
    if (at && Date.now() - current.sentAt >= SCROLL_EVERY_MS) flushScroll(current, at);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLImageElement>) => {
    const current = pointer.current;
    if (!current || current.id !== event.pointerId) return;
    pointer.current = undefined;
    const at = fractionAt(current.x, current.y);
    if (!at) return;
    if (current.scrolling) flushScroll(current, at);
    else void send({ kind: "click", ...at });
  };
  const onWheel = (event: WheelEvent<HTMLImageElement>) => {
    const rect = image.current?.getBoundingClientRect();
    const at = fractionAt(event.clientX, event.clientY);
    if (!canDrive || !rect || !at) return;
    void send({ kind: "scroll", ...at, dx: event.deltaX / rect.width, dy: event.deltaY / rect.height });
  };
  // A hardware keyboard on the picture types into the page directly.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!canDrive || event.metaKey || event.ctrlKey || event.altKey || event.target !== event.currentTarget) return;
    const key = (view === "browser" ? PREVIEW_INPUT_KEYS : SCREEN_INPUT_KEYS).find((candidate) => candidate === event.key);
    if (key) {
      event.preventDefault();
      void send({ kind: "key", key: key as PreviewInputKey & ScreenInputKey });
    } else if (event.key.length === 1) {
      event.preventDefault();
      void send({ kind: "text", text: event.key });
    }
  };

  const typeText = (event: FormEvent) => {
    event.preventDefault();
    if (!draft || busy) return;
    const text = draft;
    // The field never keeps what went to the page, least of all a password.
    setDraft("");
    setBusy(true);
    void send({ kind: "text", text }).finally(() => setBusy(false));
  };
  const openAddress = (event: FormEvent) => {
    event.preventDefault();
    setEditing(false);
    if (address.trim()) void previewKit.open({ url: address.trim() }).then(() => setError(""), (problem: unknown) => setError(errorMessage(problem)));
  };
  const navigate = (action: "back" | "forward" | "reload") => {
    void previewKit.navigate({ action }).then(() => setError(""), (problem: unknown) => setError(errorMessage(problem)));
  };

  const driver = state.driver && !state.driver.dismissed && state.driver.source === view ? state.driver : undefined;
  // The stage says it in words already.
  const problem = noWindow && /No Tau window/u.test(error) ? "" : error;
  const status = problem
    || (view === "browser" ? (state.loading ? "Loading…" : state.title || state.url) : windowName(driven) ?? "The window the agent drives")
    || "";
  const empty = view === "browser"
    ? noWindow ? <NoDisplay state={state} machine={machine} /> : !state.available
      ? <Empty icon={<Globe size={20} />} title="The Preview needs Tau on the host" description="Open the Tau desktop app on the computer this host runs on; the page is drawn there." />
      : <Empty icon={<Globe size={20} />} title="Nothing open" description={mayOpen ? "Type an address above, or ask the agent to open one." : "The page an agent or the host opens shows here."} />
    : <Empty icon={<AppWindow size={20} />} title="No window yet" description="The window this thread's agent drives shows here once it has looked at one." />;

  return <section className={`panel-body preview-remote${compact ? " compact" : ""}${hold ? " held" : ""}`} aria-label="Preview on this device">
    {hold?.Bar && compact ? <hold.Bar actions={actions} /> : null}
    <header className="preview-remote-bar">
      {view === "browser" ? <>
        <button type="button" className="preview-remote-icon" aria-label="Back" {...tooltipProps(mayNavigate ? "Back" : READ_ONLY_REASON)} disabled={!mayNavigate || !state.canGoBack} onClick={() => navigate("back")}><ArrowLeft size={18} /></button>
        <button type="button" className="preview-remote-icon" aria-label="Forward" {...tooltipProps(mayNavigate ? "Forward" : READ_ONLY_REASON)} disabled={!mayNavigate || !state.canGoForward} onClick={() => navigate("forward")}><ArrowRight size={18} /></button>
        <button type="button" className="preview-remote-icon" aria-label="Reload" {...tooltipProps(mayNavigate ? "Reload" : READ_ONLY_REASON)} disabled={!mayNavigate || !state.url} onClick={() => navigate("reload")}><RotateCw size={18} /></button>
        <form className="preview-remote-address" onSubmit={openAddress}>
          <input
            aria-label="Preview address"
            placeholder="localhost:3000"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            readOnly={!mayOpen}
            {...tooltipProps(mayOpen ? undefined : READ_ONLY_REASON)}
            value={address}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onChange={(event) => setAddress(event.target.value)}
          />
        </form>
      </> : <span className="preview-remote-title">{status}</span>}
      {screen ? <div className="preview-views" role="tablist" aria-label="Preview shows">
        <button type="button" role="tab" aria-selected={view === "browser"} aria-label="Browser" className={view === "browser" ? "preview-view active" : "preview-view"} {...tooltipProps("The page")} onClick={() => previewView.set("browser")}><Globe size={14} /></button>
        <button type="button" role="tab" aria-selected={view === "screen"} aria-label="Screen" className={view === "screen" ? "preview-view active" : "preview-view"} {...tooltipProps("The window the agent drives")} onClick={() => previewView.set("screen")}><AppWindow size={14} /></button>
      </div> : null}
    </header>
    <div className={problem ? "preview-remote-status error" : "preview-remote-status"} role="status">
      {driver ? <span className="preview-remote-driver" {...tooltipProps("An agent is working here; what you do goes to the same page")}><Bot size={12} aria-hidden="true" />Agent</span> : null}
      <span className="preview-remote-status-text">{view === "browser" || problem ? status : null}</span>
      {view === "browser" && state.url ? <LayoutStatus state={state} id={id} viewer={viewer} allowed={mayLayOut} onError={setError} /> : null}
      {frames.reduced ? <span className="preview-remote-reduced" {...tooltipProps("The connection is slow, so the picture is smaller")}>low detail</span> : null}
    </div>
    <div
      ref={stage}
      className={`preview-remote-stage${canDrive ? " drivable" : ""}`}
      data-sheet-drag="off"
      tabIndex={canDrive && !compact ? 0 : -1}
      aria-label={canDrive ? "The page: tap to click, drag to scroll" : "The page"}
      onKeyDown={onKeyDown}
    >
      {source && frames.picture
        ? <img
          ref={image}
          src={frames.picture.url}
          width={frames.picture.width}
          height={frames.picture.height}
          {...(fitted ? { style: { width: `${String(fitted.width)}px`, height: `${String(fitted.height)}px` } } : {})}
          alt={view === "browser" ? `The page: ${state.title || state.url}` : "The window the agent drives"}
          draggable={false}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { pointer.current = undefined; }}
          onWheel={onWheel}
        />
        : source ? <span className="preview-remote-waiting">Waiting for a picture…</span> : empty}
    </div>
    {readOnly ? <p className="preview-remote-note">{READ_ONLY_NOTE}</p> : <>
      <form className="preview-remote-type" onSubmit={typeText}>
        <input
          aria-label={secret ? "Password for the page" : "Text for the page"}
          type={secret ? "password" : "text"}
          placeholder={secret ? "Password: goes to the page, never recorded" : "Type into the focused field"}
          autoComplete={secret ? "current-password" : "off"}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          disabled={!canDrive}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="preview-remote-icon primary" aria-label="Send the text" {...tooltipProps("Send the text to the page")} disabled={!canDrive || !draft || busy}><Send size={18} /></button>
      </form>
      <div className="preview-remote-keys" role="toolbar" aria-label="Keys" data-sheet-drag="off">
        {KEY_BAR.map((entry) => <button
          key={entry.key}
          type="button"
          className="preview-remote-key"
          aria-label={entry.title}
          disabled={!canDrive}
          onClick={() => void send({ kind: "key", key: entry.key })}
        >{entry.key === "Enter" ? <CornerDownLeft size={16} aria-hidden="true" /> : entry.key === "Backspace" ? <Delete size={16} aria-hidden="true" /> : entry.label}</button>)}
      </div>
    </>}
    {hold?.Footer && compact ? <hold.Footer /> : null}
  </section>;
}
