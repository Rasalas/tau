import { Suspense, lazy, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Hand, Monitor, RotateCw, Smartphone, X } from "lucide-react";
import { errorMessage, reserveRegion, tooltipProps, type PanelProps } from "tau";
import { overlayWatch } from "./overlay-watch.js";
import { activeThread, previewHold, previewView, screenService, type PreviewView } from "./screen-store.js";
import { isPreviewState, notePanelShown, previewKit, previewStore, readPreviewState, usePreviewState } from "./store.js";
import { RecentPages, RecentSuggestions, useRecentPages } from "./recent.js";
import { PortSuggestions } from "./suggestions.js";
import { PreviewTools } from "./tools.js";
import { useLiveFrames, type LiveFrameAnswer, type LiveFrameSource } from "./live-frames.js";

// Evaluated the first time someone looks at a driven window.
const ScreenView = lazy(() => import("./screen-view.js"));

const pageFrames: LiveFrameSource = async (maxWidth, since) =>
  await previewKit["live-frame"]({ maxWidth, ...(since ? { since } : {}) }) as LiveFrameAnswer;

/** The page as another device has it laid out: this window shows its pictures, never the page itself. */
function DevicePicture({ element }: { element: React.RefObject<HTMLDivElement | null> }) {
  const frames = useLiveFrames(pageFrames, element);
  return frames.picture
    ? <img className="preview-device-picture" src={frames.picture.url} alt="The page, laid out for another device" draggable={false} />
    : null;
}

const VIEWS: { id: PreviewView; label: string }[] = [{ id: "browser", label: "Browser" }, { id: "screen", label: "Screen" }];

/**
 * The panel is deliberately empty below its toolbar: the page is a
 * `WebContentsView` the host draws over that rectangle, so the panel's work is
 * to say where the rectangle is and when it is gone.
 */
export function PreviewPanel({ active, placement, actions }: PanelProps) {
  const surface = useRef<HTMLDivElement>(null);
  const state = usePreviewState();
  const screen = screenService.use();
  const chosen = previewView.use();
  const view: PreviewView = screen ? chosen : "browser";
  const threadId = activeThread.use() ?? actions?.activeThread?.()?.sessionId;
  const held = Boolean(previewHold.use());
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [addressFocused, setAddressFocused] = useState(false);
  const editing = useRef(false);
  const covered = useRef(false);
  // React detaches the ref before an unmount effect runs, so the last measured
  // rectangle is what the closing `visible: false` report has to carry.
  const box = useRef({ x: 0, y: 0, width: 0, height: 0 });

  const report = useCallback((visible: boolean) => {
    const element = surface.current;
    if (element) {
      const rect = element.getBoundingClientRect();
      box.current = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    const rect = box.current;
    const drawable = visible && !covered.current && rect.width > 0 && rect.height > 0;
    reserveRegion(drawable
      ? { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height }
      : undefined);
    void previewKit.bounds({ ...rect, visible: drawable }).catch(() => undefined);
  }, []);

  // A reloaded renderer missed the pushes; ask the host what it shows.
  useEffect(() => {
    void previewKit.state().then((value) => { if (isPreviewState(value)) previewStore.set(readPreviewState(value)); }).catch(() => undefined);
  }, []);

  useEffect(() => { if (!editing.current) setDraft(state.url); }, [state.url]);

  useEffect(() => {
    notePanelShown(active);
    return () => notePanelShown(false);
  }, [active]);

  // A move between dock and stage keeps the panel mounted, so `placement` re-reports the bounds.
  // The Screen view hides the page: its rectangle is gone with the surface.
  useEffect(() => {
    if (!surface.current || !active) {
      report(false);
      return undefined;
    }
    const follow = () => report(true);
    const observer = new ResizeObserver(follow);
    observer.observe(surface.current);
    window.addEventListener("resize", follow);
    // The dock can move under the panel without resizing it.
    window.addEventListener("scroll", follow, true);
    // A modal, the palette or the settings sheet cannot be drawn over the view,
    // so the view leaves the window while one is up. Subscribing reports the
    // current answer at once, which is also this effect's first bounds report:
    // a panel that mounts under an open modal starts hidden, and one that is
    // resized under it stays hidden.
    const stopWatching = overlayWatch.subscribe((blocked) => {
      covered.current = blocked;
      follow();
    });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, true);
      stopWatching();
      report(false);
    };
  }, [active, placement, report, view]);

  const guard = (work: Promise<unknown>) => {
    void work.then(() => setError("")).catch((problem: unknown) => setError(errorMessage(problem)));
  };
  const openUrl = (url: string) => {
    editing.current = false;
    setDraft(url);
    guard(previewKit.open({ url }));
  };
  const cwd = actions?.activeThread?.()?.cwd;
  const recent = useRecentPages(state.url);

  return <section className={`panel-body preview-panel${held ? " held" : ""}`} data-keybinding-context="preview">
    <header className="panel-header">
      <h2>Preview</h2>
      {screen ? <div className="preview-views" role="tablist" aria-label="Preview shows">
        {VIEWS.map((entry) => <button
          key={entry.id}
          role="tab"
          aria-selected={view === entry.id}
          className={view === entry.id ? "preview-view active" : "preview-view"}
          onClick={() => previewView.set(entry.id)}
        >{entry.label}</button>)}
      </div> : null}
      <span className="spacer" />
      {view === "browser" ? <button type="button" className="icon-button" aria-label="Close the page" {...tooltipProps("Close the page", { side: "bottom" })} onClick={() => guard(previewKit.close())}><X size={14} /></button> : null}
    </header>
    {view === "screen" && screen ? <Suspense fallback={<section className="screen-view" />}>
      <ScreenView service={screen} threadId={threadId} />
    </Suspense> : <>
      <div className="preview-toolbar">
        <button className="icon-button compact" aria-label="Back" {...tooltipProps("Back")} disabled={!state.canGoBack} onClick={() => guard(previewKit.navigate({ action: "back" }))}><ArrowLeft size={13} /></button>
        <button className="icon-button compact" aria-label="Forward" {...tooltipProps("Forward")} disabled={!state.canGoForward} onClick={() => guard(previewKit.navigate({ action: "forward" }))}><ArrowRight size={13} /></button>
        <button className="icon-button compact" aria-label="Reload" {...tooltipProps("Reload", { shortcut: "⌘R" })} onClick={() => guard(previewKit.navigate({ action: "reload" }))}><RotateCw size={13} /></button>
        <form onSubmit={(event) => { event.preventDefault(); openUrl(draft); }}>
          <input
            aria-label="Preview address"
            placeholder="localhost:3000"
            spellCheck={false}
            value={draft}
            onChange={(event) => { editing.current = true; setDraft(event.target.value); }}
            onFocus={() => setAddressFocused(true)}
            onBlur={() => { editing.current = false; setAddressFocused(false); }}
          />
        </form>
        {held ? <span className="preview-held"><Hand size={11} aria-hidden="true" />you have control</span> : null}
      </div>
      {active && (addressFocused || !state.url) ? <PortSuggestions cwd={cwd} current={state.url} onOpen={openUrl} /> : null}
      {active && addressFocused ? <RecentSuggestions entries={recent.entries} typed={draft} current={state.url} onOpen={openUrl} onForget={recent.forget} /> : null}
      <PreviewTools state={state} actions={actions} run={(work) => guard(work())} />
      {state.layoutFor ? <div className="preview-layout-note" role="status">
        {state.layoutFor.touch ? <Smartphone size={12} aria-hidden="true" /> : <Monitor size={12} aria-hidden="true" />}
        <span {...tooltipProps(`The page is laid out for “${state.layoutFor.name}”, which shows it (${String(state.layoutFor.width)}×${String(state.layoutFor.height)})`)}>{`Laid out for “${state.layoutFor.name}” · ${String(state.layoutFor.width)}×${String(state.layoutFor.height)}`}</span>
        <button type="button" className="text-button" onClick={() => guard(previewKit.layout({}))}>Use this window's size</button>
      </div> : null}
      <div className={error ? "preview-status error" : "preview-status"}>
        {error || state.recordingNotice || (state.loading ? "loading…" : state.title || "nothing loaded")}
      </div>
      <div className="preview-surface" ref={surface}>
        {state.layoutFor && state.url ? <DevicePicture element={surface} /> : null}
        {!state.url && !state.loading ? <RecentPages entries={recent.entries} onOpen={openUrl} onForget={recent.forget} /> : null}
      </div>
    </>}
  </section>;
}
