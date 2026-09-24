import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent } from "react";
import { AppWindow, ArrowLeft, ArrowRight, Bot, CornerDownLeft, Delete, Globe, RotateCw, Send } from "lucide-react";
import { Empty, errorMessage, tooltipProps, useHostCapabilities, type WorkbenchActions } from "tau";
import { PREVIEW_INPUT_KEYS, type PreviewInput, type PreviewInputKey } from "./protocol.js";
import type { ComputerUseScreenService, ScreenInput, ScreenInputKey } from "./screen-protocol.js";
import { SCREEN_INPUT_KEYS } from "./screen-protocol.js";
import { activeThread, previewView, screenService, useDrivenWindow, windowName, type PreviewView } from "./screen-store.js";
import { previewKit, usePreviewState } from "./store.js";
import { useLiveFrames, type LiveFrameAnswer, type LiveFrameSource } from "./live-frames.js";

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

/** The stage's inner size, for fitting the picture into it. */
function useStageBox(stage: React.RefObject<HTMLDivElement | null>): { width: number; height: number } | undefined {
  const [box, setBox] = useState<{ width: number; height: number }>();
  useEffect(() => {
    const element = stage.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => {
      const style = getComputedStyle(element);
      const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
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

/** A frame of the page from the Preview's host half. */
const browserSource: LiveFrameSource = async (maxWidth, since) =>
  await previewKit["live-frame"]({ maxWidth, ...(since ? { since } : {}) }) as LiveFrameAnswer;

function screenSource(service: ComputerUseScreenService, threadId: string): LiveFrameSource {
  if (service.viewFrame) return async (maxWidth, since) => await service.viewFrame!(threadId, maxWidth, since) ?? null;
  // A Computer Use kit from before API 1.13.0: the driver's full-size screenshot, as it is.
  return async (_maxWidth, since) => {
    const frame = await service.frame(threadId);
    if (!frame) return null;
    const id = `d${String(frame.seq)}`;
    return id === since ? { id, unchanged: true } : { id, data: frame.data, width: frame.width, height: frame.height, mimeType: frame.mimeType };
  };
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

  const source = useMemo<LiveFrameSource | undefined>(() => {
    if (view === "browser") return state.url ? browserSource : undefined;
    return screen && threadId ? screenSource(screen, threadId) : undefined;
  }, [screen, state.url, threadId, view]);
  const frames = useLiveFrames(source, stage, { active });
  const driven = useDrivenWindow(view === "screen" ? screen : undefined, threadId);
  const box = useStageBox(stage);
  // Fitted by hand: an <img> never grows past its own size, and a small frame on a slow link would stay small.
  const fitted = frames.picture && box ? fit(frames.picture, box) : undefined;
  const canDrive = !readOnly && (view === "browser" ? Boolean(state.url) : Boolean(screen?.input && threadId));

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
  const status = error
    || (view === "browser" ? (state.loading ? "Loading…" : state.title || state.url) : windowName(driven) ?? "The window the agent drives")
    || "";
  const empty = view === "browser"
    ? !state.available
      ? <Empty icon={<Globe size={20} />} title="The Preview needs Tau on the host" description="Open the Tau desktop app on the computer this host runs on; the page is drawn there." />
      : <Empty icon={<Globe size={20} />} title="Nothing open" description={readOnly ? "The page an agent or the host opens shows here." : "Type an address above, or ask the agent to open one."} />
    : <Empty icon={<AppWindow size={20} />} title="No window yet" description="The window this thread's agent drives shows here once it has looked at one." />;

  return <section className={`panel-body preview-remote${compact ? " compact" : ""}`} aria-label="Preview on this device">
    <header className="preview-remote-bar">
      {view === "browser" ? <>
        <button type="button" className="preview-remote-icon" aria-label="Back" {...tooltipProps("Back")} disabled={readOnly || !state.canGoBack} onClick={() => navigate("back")}><ArrowLeft size={18} /></button>
        <button type="button" className="preview-remote-icon" aria-label="Forward" {...tooltipProps("Forward")} disabled={readOnly || !state.canGoForward} onClick={() => navigate("forward")}><ArrowRight size={18} /></button>
        <button type="button" className="preview-remote-icon" aria-label="Reload" {...tooltipProps("Reload")} disabled={readOnly || !state.url} onClick={() => navigate("reload")}><RotateCw size={18} /></button>
        <form className="preview-remote-address" onSubmit={openAddress}>
          <input
            aria-label="Preview address"
            placeholder="localhost:3000"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            readOnly={readOnly}
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
    <div className={error ? "preview-remote-status error" : "preview-remote-status"} role="status">
      {driver ? <span className="preview-remote-driver" {...tooltipProps("An agent is working here; what you do goes to the same page")}><Bot size={12} aria-hidden="true" />Agent</span> : null}
      <span className="preview-remote-status-text">{view === "browser" || error ? status : null}</span>
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
  </section>;
}
