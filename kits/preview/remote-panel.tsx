import { Suspense, lazy, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { AppWindow, Globe, X } from "lucide-react";
import { tooltipProps, useHostCapabilities, useThreadStore, type PanelProps, type PreferencesStore, type RegionProps } from "tau";
import { PreviewPanel } from "./panel.js";
import { miniPlayerShown } from "./mini-player.js";
import { floatingEnabled } from "./settings.js";
import { previewView, screenService, useDrivenWindow, windowName } from "./screen-store.js";
import { PREVIEW_PANEL, isPreviewState, notePanelShown, panelShown, previewKit, previewStore, readPreviewState, usePreviewState } from "./store.js";
import { useLiveFrames, type LiveFrameAnswer, type LiveFrameSource } from "./live-frames.js";

// Loaded the first time a device that is not the host's window opens the Preview.
const RemotePreview = lazy(() => import("./remote-view.js"));

/** The Preview on a device that shows frames of the host's page instead of drawing a view of its own. */
export function createRemotePreviewPanel(compact: boolean) {
  return function RemotePreviewPanel({ active, actions }: PanelProps) {
    useEffect(() => {
      notePanelShown(active);
      return () => notePanelShown(false);
    }, [active]);
    // A client that connected late missed the pushes; ask the host what it shows.
    useEffect(() => {
      void previewKit.state().then((value) => { if (isPreviewState(value)) previewStore.set(readPreviewState(value)); }).catch(() => undefined);
    }, []);
    return <Suspense fallback={<section className="panel-body preview-remote" />}>
      <RemotePreview active={active} actions={actions} compact={compact} />
    </Suspense>;
  };
}

const RemoteDesktopPanel = createRemotePreviewPanel(false);

/**
 * A desktop window draws the page itself only on the host's own machine; a
 * window on another computer would move a view it cannot see, so it shows
 * frames and drives the page like any other device.
 */
export function DesktopPreviewPanel(props: PanelProps) {
  const { localFiles } = useHostCapabilities();
  return localFiles ? <PreviewPanel {...props} /> : <RemoteDesktopPanel {...props} />;
}

const tinySource: LiveFrameSource = async (maxWidth, since) =>
  await previewKit["live-frame"]({ maxWidth, ...(since ? { since } : {}) }) as LiveFrameAnswer;

/**
 * On a phone: a strip above the composer while an agent drives the page or a
 * window and the Preview sheet is closed. It shows a small live picture and
 * opens the sheet on a tap; the picture is fetched only while the strip shows.
 */
export function createMiniBarRegion(preferences: PreferencesStore) {
  return function PreviewMiniBar({ actions }: RegionProps) {
    const state = usePreviewState();
    const shown = panelShown.use();
    const screen = screenService.use();
    const enabled = useSyncExternalStore(preferences.subscribe, useCallback(() => floatingEnabled(preferences), []));
    const driver = miniPlayerShown(state, { enabled, panelShown: shown, screen: Boolean(screen) });
    const thumb = useRef<HTMLSpanElement>(null);
    const browser = driver?.source === "browser";
    const frames = useLiveFrames(browser ? tinySource : undefined, thumb, { active: Boolean(driver) });
    const threads = useThreadStore();
    const index = useSyncExternalStore(threads.subscribe, threads.getSnapshot);
    const driven = useDrivenWindow(driver && !browser ? screen : undefined, driver?.threadId);
    if (!driver) return null;
    const thread = index.threads.find((entry) => entry.id === driver.threadId);
    const title = thread?.title || "an agent";
    const what = browser ? state.title || state.url : windowName(driven) ?? "A window";
    const open = () => {
      // The Screen view shows the thread on screen, so the driving thread comes first.
      if (!browser && thread?.path && actions.activeThread()?.sessionId !== driver.threadId) void actions.switchSession(thread.path);
      previewView.set(browser ? "browser" : "screen");
      actions.openPanel(PREVIEW_PANEL);
    };
    return <div className="preview-minibar" role="group" aria-label="What an agent is using">
      <button type="button" className="preview-minibar-open" onClick={open} aria-label={`Open the Preview: ${what}`}>
        <span className="preview-minibar-thumb" ref={thumb} aria-hidden="true">
          {browser && frames.picture ? <img src={frames.picture.url} alt="" draggable={false} /> : browser ? <Globe size={16} /> : <AppWindow size={16} />}
        </span>
        <span className="preview-minibar-text">
          <strong>{what}</strong>
          <small>Used by “{title}”</small>
        </span>
      </button>
      <button type="button" className="preview-minibar-close" aria-label="Hide until an agent drives again" {...tooltipProps("Hide until an agent drives again")} onClick={() => void previewKit["mini-dismiss"]().catch(() => undefined)}><X size={18} /></button>
    </div>;
  };
}
