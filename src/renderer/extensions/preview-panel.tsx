import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RotateCw } from "lucide-react";
import { errorMessage } from "../error-message";
import type { PanelProps } from "../extension-system";
import { isPreviewState, previewKit, previewStore, usePreviewState } from "./preview-store";

/**
 * The panel is deliberately empty below its toolbar: the page is a
 * `WebContentsView` the host draws over that rectangle, so the panel's work is
 * to say where the rectangle is and when it is gone.
 */
export function PreviewPanel({ active, extensionName }: PanelProps) {
  const surface = useRef<HTMLDivElement>(null);
  const state = usePreviewState();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const editing = useRef(false);

  const report = useCallback((visible: boolean) => {
    const element = surface.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const drawable = visible && rect.width > 0 && rect.height > 0;
    void previewKit
      .bounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: drawable })
      .catch(() => undefined);
  }, []);

  // A reloaded renderer missed the pushes; ask the host what it shows.
  useEffect(() => {
    void previewKit.state().then((value) => { if (isPreviewState(value)) previewStore.set(value); }).catch(() => undefined);
  }, []);

  useEffect(() => { if (!editing.current) setDraft(state.url); }, [state.url]);

  useEffect(() => {
    if (!surface.current || !active) {
      report(false);
      return undefined;
    }
    report(true);
    const follow = () => report(true);
    const observer = new ResizeObserver(follow);
    observer.observe(surface.current);
    window.addEventListener("resize", follow);
    // The dock can move under the panel without resizing it.
    window.addEventListener("scroll", follow, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, true);
      report(false);
    };
  }, [active, report]);

  const guard = (work: Promise<unknown>) => {
    void work.then(() => setError("")).catch((problem: unknown) => setError(errorMessage(problem)));
  };

  return <section className="panel-body preview-panel">
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
      <form onSubmit={(event) => { event.preventDefault(); editing.current = false; guard(previewKit.open({ url: draft })); }}>
        <input
          aria-label="Preview address"
          placeholder="localhost:3000"
          spellCheck={false}
          value={draft}
          onChange={(event) => { editing.current = true; setDraft(event.target.value); }}
          onBlur={() => { editing.current = false; }}
        />
      </form>
    </div>
    <div className={error ? "preview-status error" : "preview-status"}>
      {error || (state.loading ? "loading…" : state.title || "nothing loaded")}
    </div>
    <div className="preview-surface" ref={surface} />
  </section>;
}
