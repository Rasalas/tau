import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { AppWindow, ArrowUpToLine, Bot, Globe, PanelRight, X } from "lucide-react";
import { errorMessage, READ_ONLY_REASON, tooltipProps, useClientStorage, useCommandAllowed, useThreadStore, type PreferencesStore, type RegionProps, type WorkbenchActions } from "tau";
import { AgentCursorLayer } from "./agent-cursor.js";
import { PREVIEW_HOST_EXTENSION_ID, type PreviewDriver, type PreviewMiniCorner, type PreviewMiniPrefs, type PreviewState } from "./protocol.js";
import type { ComputerUseScreenService, ScreenState } from "./screen-protocol.js";
import { previewView, screenService } from "./screen-store.js";
import { PREVIEW_PANEL, drawsFrames, panelShown, previewKit, usePreviewState } from "./store.js";
import { floatingEnabled } from "./settings.js";
import { useLiveFrames, type LiveFrameAnswer, type LiveFrameSource } from "./live-frames.js";
import { loadDeviceMiniPrefs, saveDeviceMiniPrefs } from "./mini-prefs.js";

/** How much a hover enlarges the player, before the room around it caps it. */
const HOVER_SCALE = 2.5;
const EDGE = 12;
const HEADER = 26;
const TALLEST = 3 / 4;
export const MINI_WIDTH = { min: 160, max: 560 } as const;

export interface MiniInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface Picture {
  url: string;
  width: number;
  height: number;
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

/**
 * Where the player may go: the chat column, above the composer. The region's
 * next sibling is the composer, which grows while a turn runs.
 */
function useInsets(anchor: React.RefObject<HTMLElement | null>): MiniInsets | undefined {
  const [insets, setInsets] = useState<MiniInsets | undefined>();
  useLayoutEffect(() => {
    const element = anchor.current;
    const slot = element?.parentElement;
    const column = element?.closest(".conversation-column") ?? document.body;
    if (!element || !slot) return undefined;
    const measure = () => {
      const area = column.getBoundingClientRect();
      const composerTop = (slot.nextElementSibling ?? slot).getBoundingClientRect().top;
      const next = {
        top: Math.round(area.top + EDGE),
        left: Math.round(area.left + EDGE),
        right: Math.round(window.innerWidth - area.right + EDGE),
        bottom: Math.round(window.innerHeight - Math.min(area.bottom, composerTop) + EDGE),
      };
      setInsets((current) => current && JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    observer.observe(slot);
    if (slot.nextElementSibling) observer.observe(slot.nextElementSibling);
    if (slot.parentElement) observer.observe(slot.parentElement);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchor]);
  return insets;
}

/** A frame of the page from the host, at the width the player draws. */
const pageFrames: LiveFrameSource = async (maxWidth, since) =>
  await previewKit["live-frame"]({ maxWidth, ...(since ? { since } : {}) }) as LiveFrameAnswer;

/** The driven window's state and latest screenshot, from Computer Use's service. */
function useScreenFrame(service: ComputerUseScreenService | undefined, threadId: string | undefined): { state?: ScreenState; picture?: Picture } {
  const [state, setState] = useState<ScreenState | undefined>(() => service && threadId ? service.state(threadId) : undefined);
  const [picture, setPicture] = useState<Picture | undefined>();
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
  const seq = state?.frame?.seq;
  useEffect(() => {
    if (!service || !threadId || seq === undefined) return undefined;
    let live = true;
    void service.frame(threadId, seq).then((frame) => {
      if (live && frame) setPicture({ url: `data:${frame.mimeType};base64,${frame.data}`, width: frame.width, height: frame.height });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [seq, service, threadId]);
  return { ...(state ? { state } : {}), ...(picture ? { picture } : {}) };
}

type Gesture = { kind: "move" | "resize"; pointerId: number; x: number; y: number; width: number };

/**
 * The floating preview: a picture of the page or window an agent drives
 * while the Preview panel is out of sight. It only shows: a click on the
 * picture opens the Preview, never the page under it. Hover enlarges it;
 * dragging the header moves it to another corner, its inner edge resizes
 * it, and this device remembers both for itself (a phone and a laptop have
 * different room for it).
 */
function MiniPlayer({ driver, state, insets, actions }: { driver: PreviewDriver; state: PreviewState; insets: MiniInsets; actions: WorkbenchActions }) {
  const service = screenService.use();
  const screen = driver.source === "screen";
  const storage = useClientStorage();
  // A device that never moved the player starts where the host kept it for every client before.
  const [prefs, setPrefs] = useState<PreviewMiniPrefs>(() => loadDeviceMiniPrefs(storage, state.mini));
  const keep = (next: PreviewMiniPrefs) => {
    setPrefs(next);
    saveDeviceMiniPrefs(storage, next);
  };
  const mayDismiss = useCommandAllowed(PREVIEW_HOST_EXTENSION_ID, "mini-dismiss");
  const [drag, setDrag] = useState<{ dx: number; dy: number } | undefined>();
  const [resizing, setResizing] = useState(false);
  const [error, setError] = useState("");
  const gesture = useRef<Gesture | undefined>(undefined);

  const body = useRef<HTMLButtonElement>(null);
  // Sized to what the player draws, so the hover's larger picture asks for a larger frame.
  const browserFrames = useLiveFrames(screen ? undefined : pageFrames, body, { active: true });
  const browserPicture = browserFrames.picture;
  const { state: screenState, picture: screenPicture } = useScreenFrame(screen ? service : undefined, screen ? driver.threadId : undefined);
  const picture = screen ? screenPicture : browserPicture;

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
  const large = enlargedWidth(prefs.width, aspect, insets, { width: window.innerWidth, height: window.innerHeight });
  const [vertical, horizontal] = prefs.corner.split("-") as ["top" | "bottom", "left" | "right"];

  const begin = (kind: Gesture["kind"]) => (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (kind === "move" && (event.target as Element).closest("button"))) return;
    gesture.current = { kind, pointerId: event.pointerId, x: event.clientX, y: event.clientY, width: prefs.width };
    if (kind === "resize") setResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (current.kind === "move") setDrag({ dx, dy });
    else {
      const grown = current.width + (horizontal === "right" ? -dx : dx);
      setPrefs((value) => ({ ...value, width: Math.round(Math.min(MINI_WIDTH.max, Math.max(MINI_WIDTH.min, grown))) }));
    }
  };
  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setResizing(false);
    if (current.kind === "move") {
      // Where the header is let go says the corner; a tall card's centre barely moves.
      const corner = nearestCorner({ x: event.clientX, y: event.clientY }, { ...insets, width: window.innerWidth, height: window.innerHeight });
      setDrag(undefined);
      keep({ ...prefs, corner });
    } else {
      keep(prefs);
    }
  };

  const style: React.CSSProperties & Record<`--${string}`, string> = {
    [vertical]: `${insets[vertical]}px`,
    [horizontal]: `${insets[horizontal]}px`,
    // CSS enlarges it on hover and focus; while dragged it keeps the width being set.
    "--mini-width": `${prefs.width}px`,
    "--mini-large": `${large}px`,
    "--mini-aspect": `${aspect}`,
    ...(drag ? { transform: `translate(${drag.dx}px, ${drag.dy}px)` } : {}),
  };

  return <section
    className={`preview-mini ${prefs.corner}${drag || resizing ? " dragging" : ""}`}
    style={style}
    aria-label="Floating preview"
    data-preview-mini={driver.source}
    onPointerEnter={() => browserFrames.poke()}
    onFocus={() => browserFrames.poke()}
  >
    <header className="preview-mini-head" onPointerDown={begin("move")} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <span className="preview-mini-source" aria-label={sourceTitle} {...tooltipProps(sourceTitle, { side: "bottom" })}>
        {screen ? <AppWindow size={12} /> : <Globe size={12} />}
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
      <button type="button" className="icon-button compact" aria-label="Hide the floating preview" disabled={!mayDismiss} {...tooltipProps(mayDismiss ? "Hide until an agent drives again" : READ_ONLY_REASON, { side: "bottom" })} onClick={() => run(() => previewKit["mini-dismiss"]())}><X size={12} /></button>
    </header>
    <button ref={body} type="button" className={cropped ? "preview-mini-body cropped" : "preview-mini-body"} aria-label={`Open in Preview: ${sourceTitle}`} onClick={openInPreview}>
      {picture ? <img src={picture.url} alt="" draggable={false} /> : <span className="preview-mini-waiting">Waiting for a picture…</span>}
      {screen && screenState ? <AgentCursorLayer actions={screenState.actions} {...(screenState.frame ? { space: { width: screenState.frame.width, height: screenState.frame.height } } : {})} /> : null}
    </button>
    {error ? <div className="preview-mini-error" role="status">{error}</div> : null}
    <span
      className={`preview-mini-resize ${horizontal === "left" ? "right" : "left"}`}
      role="presentation"
      onPointerDown={begin("resize")}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    />
  </section>;
}

/**
 * The region that holds the floating preview. It sits above the composer,
 * where it measures the chat column, and draws the player fixed over it.
 */
export function createMiniPlayerRegion(preferences: PreferencesStore) {
  return function PreviewMiniPlayer({ actions }: RegionProps) {
    const anchor = useRef<HTMLSpanElement>(null);
    const state = usePreviewState();
    const shown = panelShown.use();
    const screen = screenService.use();
    const enabled = useSyncExternalStore(preferences.subscribe, useCallback(() => floatingEnabled(preferences), []));
    const driver = miniPlayerShown(state, { enabled, panelShown: shown, screen: Boolean(screen) });
    const insets = useInsets(anchor);
    return <>
      <span ref={anchor} className="preview-mini-anchor" aria-hidden="true" />
      {driver && insets ? <MiniPlayer key={`${driver.threadId}:${driver.source}`} driver={driver} state={state} insets={insets} actions={actions} /> : null}
    </>;
  };
}
