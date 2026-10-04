import { useEffect, useRef, useState } from "react";
import { RESOURCE_UNAVAILABLE, resourceRelativePath, transcriptFilePath, useWorkspaceResources } from "../workspace-resource-context";
import type { VisualizationReference } from "./visualization-markers";

/** Absolute executor paths only name files within the captured workspace; never this device. */
export function visualizationRelativePath(path: string, displayPath?: string): string {
  if (path.includes("\\") && !/^[A-Za-z]:\\/u.test(path)) throw new Error("Name a file inside the thread's workspace.");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path) && !/^[A-Za-z]:[\\/]/u.test(path)) throw new Error("Name a file inside the thread's workspace.");
  const relative = transcriptFilePath(path, displayPath);
  return resourceRelativePath(relative);
}

/** Custom themes declare a single CSS scheme; system themes follow the device. */
export function visualizationTheme(): "light" | "dark" {
  const root = document.documentElement;
  const preference = root.dataset.theme;
  if (preference === "light" || preference === "dark") return preference;
  const scheme = getComputedStyle(root).colorScheme.trim();
  if (scheme === "light" || scheme === "dark") return scheme;
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function InlineVisualization({ reference }: { reference: VisualizationReference }) {
  const resources = useWorkspaceResources();
  const frame = useRef<HTMLIFrameElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [result, setResult] = useState<{ resources: typeof resources; path: string; theme: "light" | "dark"; url?: string; error?: string }>();
  const [height, setHeight] = useState(600);
  const [expanded, setExpanded] = useState(false);
  const [readyUrl, setReadyUrl] = useState<string>();
  const [theme, setTheme] = useState<"light" | "dark">(visualizationTheme);
  let path: string | undefined;
  try { path = visualizationRelativePath(reference.path, resources?.displayPath); } catch { /* Render guidance. */ }

  useEffect(() => {
    const update = () => setTheme(visualizationTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener("change", update);
    return () => { observer.disconnect(); media?.removeEventListener("change", update); };
  }, []);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (element.open) element.close();
    if (expanded) element.showModal();
    else element.show();
  }, [expanded]);
  useEffect(() => {
    if (!path || !resources?.available || !resources.loadVisualization) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    void resources.loadVisualization(path, theme).then((value) => {
      if (cancelled) { value.release?.(); return; }
      release = value.release;
      setResult({ resources, path, theme, url: value.url });
    }, (error: unknown) => {
      if (cancelled) return;
      const message = error instanceof Error ? error.message : "The visualization could not be loaded.";
      setResult({ resources, path, theme, error: message });
    });
    return () => { cancelled = true; release?.(); };
  }, [path, resources, theme]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      // Untrusted frame can only suggest bounded layout, never trigger host commands.
      if (event.source !== frame.current?.contentWindow || event.data?.type !== "tau-visualization-height") return;
      const proposed = event.data.height;
      if (typeof proposed === "number" && Number.isFinite(proposed)) {
        setHeight(Math.max(120, Math.min(2000, proposed)));
        setReadyUrl(result?.url);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [result?.url]);
  const current = result && result.resources === resources && result.path === path && result.theme === theme ? result : undefined;
  useEffect(() => {
    if (!current?.url || current.url === readyUrl) return;
    // Missing/expired resource responses have no runtime handshake and would otherwise remain blank.
    const timeout = window.setTimeout(() => setResult({ resources, path: path!, theme, error: "The visualization did not load. Open its source or reconnect to the host and try again." }), 15000);
    return () => window.clearTimeout(timeout);
  }, [current?.url, path, readyUrl, resources, theme]);
  const error = !path ? "This visualization must be inside the thread's workspace. Ask for a workspace-relative visualization file."
    : !resources?.available ? RESOURCE_UNAVAILABLE
    : !resources.loadVisualization ? "This host does not support inline visualizations. Update the host to display this file."
    : current?.error;
  const title = reference.title || "Visualization";
  const surface = error ? <div role="status">{error}{path && resources?.available ? <> <button type="button" className="text-button" style={{ minHeight: 32 }} onClick={() => resources.openFile(path)}>Open visualization source</button></> : null}</div>
    : current?.url ? <iframe key="visualization-frame" ref={frame} title={title} src={current.url} sandbox="allow-scripts" referrerPolicy="no-referrer" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" onError={() => setResult({ resources, path: path!, theme, error: "The visualization could not be displayed." })} style={{ display: "block", width: "100%", height, border: 0 }} />
      : <div role="status">Loading visualization…</div>;
  return <section className="inline-visualization" data-mode={reference.mode} style={{ width: "100%" }}>
    {reference.mode === "wide" ? <button type="button" className="text-button" style={{ minHeight: 32 }} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>Expand visualization</button> : null}
    <dialog ref={dialog} aria-label={title} role={expanded ? "dialog" : "group"} data-preview-overlay={expanded || undefined} onCancel={(event) => { event.preventDefault(); setExpanded(false); }} style={expanded
      ? { width: "min(1024px, calc(100vw - 48px))", maxWidth: "none", maxHeight: "calc(100vh - 48px)", padding: 16, background: "var(--stage)", color: "var(--ink)", border: "1px solid var(--line)" }
      : { position: "static", width: "100%", maxWidth: "none", margin: 0, padding: 0, border: 0, background: "transparent", color: "inherit" }}>
      <button type="button" className="text-button" hidden={!expanded} style={{ minHeight: 32 }} onClick={() => setExpanded(false)}>Collapse visualization</button>{surface}
    </dialog>
  </section>;
}
