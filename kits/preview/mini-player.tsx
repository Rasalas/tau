import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AppWindow, ArrowUpToLine, Bot, Globe, PanelRight, X } from "lucide-react";
import { errorMessage, READ_ONLY_REASON, tooltipProps, useCommandAllowed, useThreadStore, type PreferencesStore, type RegionProps, type WorkbenchActions } from "tau";
import { AgentCursorLayer } from "./agent-cursor.js";
import { PREVIEW_HOST_EXTENSION_ID, type PreviewDriver, type PreviewMiniCorner, type PreviewState } from "./protocol.js";
import type { ComputerUseScreenService, ScreenState } from "./screen-protocol.js";
import { previewView, screenService } from "./screen-store.js";
import { PREVIEW_PANEL, drawsFrames, panelShown, previewKit, usePreviewState } from "./store.js";
import { floatingEnabled } from "./settings.js";
import { useLiveFrames, type LiveFrameAnswer, type LiveFrameSource } from "./live-frames.js";
import { screenFrameSource } from "./screen-frames.js";

/** How much a hover enlarges the player, before the room around it caps it. */
const HOVER_SCALE = 2.5;
const HEADER = 26;
const TALLEST = 3 / 4;
export const MINI_WIDTH = { min: 160, max: 560 } as const;

export interface MiniInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Whether the floating preview has something to show and room to show it. */
export function miniPlayerShown(state: PreviewState, options: { enabled: boolean; panelShown: boolean; screen: boolean }): PreviewDriver | undefined {
  const driver = state.driver;
  if (!options.enabled || options.panelShown || !driver || driver.dismissed) return undefined;
  if (driver.source === "browser" && !state.url) return undefined;
  if (driver.source === "screen" && !options.screen) return undefined;
  return driver;
}

/** The corner nearest to the point where a dragged player was let go. */
export function nearestCorner(center: { x: number; y: number }, area: MiniInsets & { width: number; height: number }): PreviewMiniCorner {
  const middleX = area.left + (area.width - area.left - area.right) / 2;
  const middleY = area.top + (area.height - area.top - area.bottom) / 2;
  return `${center.y < middleY ? "top" : "bottom"}-${center.x < middleX ? "left" : "right"}`;
}

/** The width a hover enlarges to: readable, but inside the chat column and above the composer. */
export function enlargedWidth(width: number, aspect: number, insets: MiniInsets, viewport: { width: number; height: number }): number {
  const room = viewport.width - insets.left - insets.right;
  const tall = (viewport.height - insets.top - insets.bottom - HEADER) * aspect;
  return Math.max(width, Math.round(Math.min(width * HOVER_SCALE, room, tall)));
}

/** A frame of the page from the host, at the width the player draws. */
const pageFrames: LiveFrameSource = async (maxWidth, since) =>
  await previewKit["live-frame"]({ maxWidth, ...(since ? { since } : {}) }) as LiveFrameAnswer;

/** The driven window, including state published before this client connected. */
function useScreenState(service: ComputerUseScreenService | undefined, threadId: string | undefined): ScreenState | undefined {
  const [state, setState] = useState<ScreenState | undefined>(() => service && threadId ? service.state(threadId) : undefined);
  useEffect(() => {
    setState(service && threadId ? service.state(threadId) : undefined);
    if (!service || !threadId) return undefined;
    let live = true;
    const stop = service.subscribe((next) => { if (next.threadId === threadId) setState(next); });
    void service.load(threadId).then((loaded) => { if (live && loaded) setState(loaded); }).catch(() => undefined);
    return () => {
      live = false;
      stop();
    };
  }, [service, threadId]);
  return state?.threadId === threadId ? state : undefined;
}


/** A frame of the agent-driven browser or window in the workbench preview region. */
function MiniPlayer({ driver, state, screenState, actions }: { driver: PreviewDriver; state: PreviewState; screenState?: ScreenState; actions: WorkbenchActions }) {
  const service = screenService.use();
  const screen = driver.source === "screen";
  const mayDismiss = useCommandAllowed(PREVIEW_HOST_EXTENSION_ID, "mini-dismiss");
  const [error, setError] = useState("");

  const [touch, setTouch] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(hover: none), (pointer: coarse)").matches);
  const [controlsShown, setControlsShown] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const hideControls = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastPointer = useRef("");
  const revealControls = () => {
    setControlsShown(true);
    if (hideControls.current) clearTimeout(hideControls.current);
    hideControls.current = setTimeout(() => { setControlsShown(false); hideControls.current = undefined; }, 4_000);
  };
  useEffect(() => {
    const query = typeof window.matchMedia === "function" ? window.matchMedia("(hover: none), (pointer: coarse)") : undefined;
    const update = () => setTouch(Boolean(query?.matches));
    query?.addEventListener?.("change", update);
    return () => {
      query?.removeEventListener?.("change", update);
      if (hideControls.current) clearTimeout(hideControls.current);
    };
  }, []);
  const body = useRef<HTMLButtonElement>(null);
  // Ask for frames at the width the dock draws.
  const source = useMemo(() => screen
    ? service ? screenFrameSource(service, driver.threadId) : undefined
    : pageFrames, [screen, service, driver.threadId, screenState?.window?.pid, screenState?.window?.windowId]);
  const frames = useLiveFrames(source, body);
  const picture = frames.picture;

  const threads = useThreadStore();
  const index = useSyncExternalStore(threads.subscribe, threads.getSnapshot);
  const thread = index.threads.find((entry) => entry.id === driver.threadId);
  const threadTitle = thread?.title || "a thread";
  const sourceTitle = screen
    ? [screenState?.window?.app, screenState?.window?.title].filter(Boolean).join(" · ") || "A window the agent drives"
    : state.title || state.url;

  const run = (work: () => Promise<unknown>) => { void work().then(() => setError("")).catch((problem: unknown) => setError(errorMessage(problem))); };
  const openInPreview = () => {
    // The Screen view shows the thread on screen, so the driving thread comes first.
    if (screen && thread && actions.activeThread()?.sessionId !== driver.threadId) void actions.switchSession(thread.path);
    previewView.set(screen ? "screen" : "browser");
    actions.openPanel(PREVIEW_PANEL);
  };

  // A page in a tall dock would make a sliver; the player shows its top at 3:4 at most.
  const natural = picture ? picture.width / Math.max(1, picture.height) : 16 / 10;
  const cropped = !screen && natural < TALLEST;
  const aspect = cropped ? TALLEST : natural;
  const style = { "--mini-aspect": `${aspect}` } as React.CSSProperties;

  return <section
    className="preview-mini preview-docked"
    style={style}
    aria-label="Agent preview"
    data-preview-mini={driver.source}
    data-touch-preview={touch || undefined}
    data-touch-controls={controlsShown || keyboardFocus || undefined}
    onPointerDownCapture={(event) => {
      lastPointer.current = event.pointerType;
      setKeyboardFocus(false);
      if (event.pointerType === "mouse" && typeof window.matchMedia === "function" && !window.matchMedia("(hover: none), (pointer: coarse)").matches) { setTouch(false); return; }
      if (touch || event.pointerType === "touch") { setTouch(true); revealControls(); }
    }}
    onKeyDownCapture={() => { lastPointer.current = ""; setKeyboardFocus(true); }}
    onFocusCapture={(event) => { if (lastPointer.current !== "touch" || event.target.matches(":focus-visible")) setKeyboardFocus(true); }}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setKeyboardFocus(false); }}
    onPointerEnter={() => frames.poke()}
    onFocus={() => frames.poke()}
  >
    <header className="preview-mini-head">
      <span className="preview-mini-source" aria-label={sourceTitle} {...tooltipProps(sourceTitle, { side: "bottom" })}>
        {screen ? <AppWindow size={12} /> : <Globe size={12} />}<span>{sourceTitle}</span>
      </span>
      <button
        type="button"
        className="icon-button compact"
        aria-label={`Driven by ${threadTitle}`}
        {...tooltipProps(`Driven by “${threadTitle}” · open the thread`, { side: "bottom" })}
        disabled={!thread}
        onClick={() => { if (thread) void actions.switchSession(thread.path); }}
      ><Bot size={12} /></button>
      <span className="spacer" />
      {/* Raising the window on the host's screen helps nobody at another computer. */}
      {screen && !drawsFrames() ? <button
        type="button"
        className="icon-button compact"
        aria-label="Jump to the app"
        disabled={!service || !screenState?.canBringToFront}
        {...tooltipProps(screenState?.canBringToFront ? "Jump to the app" : "The agent's driver cannot raise this window", { side: "bottom" })}
        onClick={() => run(async () => { await service?.bringToFront(driver.threadId); })}
      ><ArrowUpToLine size={12} /></button> : null}
      <button type="button" className="icon-button compact" aria-label="Open in Preview" {...tooltipProps("Open in Preview", { side: "bottom" })} onClick={openInPreview}><PanelRight size={12} /></button>
      <button type="button" className="icon-button compact" aria-label="Hide the agent preview" disabled={!mayDismiss} {...tooltipProps(mayDismiss ? "Hide until an agent drives again" : READ_ONLY_REASON, { side: "bottom" })} onClick={() => run(() => previewKit["mini-dismiss"]())}><X size={12} /></button>
    </header>
    <button ref={body} type="button" className={cropped ? "preview-mini-body cropped" : "preview-mini-body"} aria-label={`${touch ? "Show preview controls" : "Open in Preview"}: ${sourceTitle}`} onClick={() => { if (touch || lastPointer.current === "touch") revealControls(); else openInPreview(); }}>
      {picture ? <img src={picture.url} alt="" draggable={false} /> : <span className="preview-mini-waiting">Waiting for a picture…</span>}
      {screen && screenState ? <AgentCursorLayer actions={screenState.actions} {...(screenState.frame ? { space: { width: screenState.frame.width, height: screenState.frame.height } } : {})} /> : null}
    </button>
    {error ? <div className="preview-mini-error" role="status">{error}</div> : null}

  </section>;
}

/** Watches the host driver without opening or switching the user's stage. */
export function createMiniPlayerRegion(preferences: PreferencesStore) {
  return function PreviewMiniPlayer({ actions }: RegionProps) {
    const state = usePreviewState();
    const shown = panelShown.use();
    const screen = screenService.use();
    const enabled = useSyncExternalStore(preferences.subscribe, useCallback(() => floatingEnabled(preferences), []));
    const driver = miniPlayerShown(state, { enabled, panelShown: shown, screen: Boolean(screen) });
    const screenState = useScreenState(screen, driver?.source === "screen" ? driver.threadId : undefined);
    const ready = driver && (driver.source === "browser" || screenState?.window);
    return <>
      {ready && driver ? <MiniPlayer screenState={screenState} key={`${driver.threadId}:${driver.source}`} driver={driver} state={state} actions={actions} /> : null}
    </>;
  };
}
