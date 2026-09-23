import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import { errorMessage, reserveRegion, type PanelProps } from "tau";
import { overlayWatch } from "./overlay-watch.js";
import { isPreviewState, notePanelShown, previewKit, previewStore, usePreviewState } from "./store.js";
import { PortSuggestions } from "./suggestions.js";
import { PreviewTools } from "./tools.js";

/**
 * The panel is deliberately empty below its toolbar: the page is a
 * `WebContentsView` the host draws over that rectangle, so the panel's work is
 * to say where the rectangle is and when it is gone.
 */
export function PreviewPanel({ active, placement, extensionName, actions }: PanelProps) {
  const surface = useRef<HTMLDivElement>(null);
  const state = usePreviewState();
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
    void previewKit.state().then((value) => { if (isPreviewState(value)) previewStore.set(value); }).catch(() => undefined);
  }, []);

  useEffect(() => { if (!editing.current) setDraft(state.url); }, [state.url]);

  useEffect(() => {
    notePanelShown(active);
    return () => notePanelShown(false);
  }, [active]);

  // A move between dock and stage keeps the panel mounted, so `placement` re-reports the bounds.
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
  }, [active, placement, report]);

  const guard = (work: Promise<unknown>) => {
    void work.then(() => setError("")).catch((problem: unknown) => setError(errorMessage(problem)));
  };
  const openUrl = (url: string) => {
    editing.current = false;
    setDraft(url);
    guard(previewKit.open({ url }));
  };
  const cwd = actions?.activeThread?.()?.cwd;

  return <section className="panel-body preview-panel" data-keybinding-context="preview">
    <header className="panel-header">
      <h2>Preview</h2>
      <small>{extensionName.toLowerCase()}</small>
      <span className="spacer" />
      <button className="text-button" onClick={() => guard(previewKit.close())}>close</button>
    </header>
    <div className="preview-toolbar">
      <button className="icon-button compact" aria-label="Back" disabled={!state.canGoBack} onClick={() => guard(previewKit.navigate({ action: "back" }))}><ArrowLeft size={13} /></button>
      <button className="icon-button compact" aria-label="Forward" disabled={!state.canGoForward} onClick={() => guard(previewKit.navigate({ action: "forward" }))}><ArrowRight size={13} /></button>
      <button className="icon-button compact" aria-label="Reload" onClick={() => guard(previewKit.navigate({ action: "reload" }))}><RotateCw size={13} /></button>
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
    </div>
    {active && (addressFocused || !state.url) ? <PortSuggestions cwd={cwd} current={state.url} onOpen={openUrl} /> : null}
    <PreviewTools state={state} actions={actions} run={(work) => guard(work())} />
    <div className={error ? "preview-status error" : "preview-status"}>
      {error || state.recordingNotice || (state.loading ? "loading…" : state.title || "nothing loaded")}
    </div>
    <div className="preview-surface" ref={surface} />
  </section>;
}
