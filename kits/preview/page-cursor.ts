/**
 * What Preview Kit draws *into* the page: the agent's cursor and, while a
 * recording runs, the pointer, clicks and keys of whoever uses the page. The
 * page is a native view, so a layer of the workbench could not lie over it;
 * drawn in the page, both also land in a recording. Like `page-overlay.ts`,
 * each function travels as source text, reaches nothing from this module and
 * runs in the isolated world; styles go through the CSSOM only, which a
 * page's content security policy leaves alone.
 */

/** Where the agent's cursor goes, in fractions of the viewport; `chord`'s glyphs in `label`. */
export interface PageCursorMark {
  id: string;
  kind: "click" | "double-click" | "right-click" | "drag" | "type" | "key" | "scroll";
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  label?: string;
  failed: boolean;
}

export interface PageCursorTiming {
  activeMs: number;
  labelMs: number;
}

export interface PageInputOptions {
  keys: boolean;
  clicks: boolean;
}

/** Lucide's `mouse-pointer-2`, the glyph the Screen view's cursor uses. */
export const POINTER_PATH = "M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z";

export function previewAgentCursor(mark: PageCursorMark, timing: PageCursorTiming, pointerPath: string): boolean {
  type Layer = {
    host: HTMLElement;
    cursor: HTMLElement;
    arrow: SVGSVGElement;
    label: HTMLElement;
    corner: HTMLElement;
    drag: SVGSVGElement;
    line: SVGLineElement;
    timers: ReturnType<typeof setTimeout>[];
  };
  const scope = globalThis as unknown as { tauAgentCursor?: Layer };
  const doc = document;
  const svgNs = "http://www.w3.org/2000/svg";
  const blue = "#2f81f7";
  const labelStyle = {
    position: "absolute", maxWidth: "240px", padding: "2px 6px", borderRadius: "4px", whiteSpace: "nowrap",
    overflow: "hidden", textOverflow: "ellipsis", background: "#1f2328", color: "#ffffff", display: "none",
    font: "11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace", boxShadow: "0 1px 3px rgba(0, 0, 0, 0.3)",
  };
  let layer = scope.tauAgentCursor;
  if (!layer || !layer.host.isConnected) {
    const host = doc.createElement("div");
    host.setAttribute("data-tau-overlay", "agent-cursor");
    host.setAttribute("aria-hidden", "true");
    Object.assign(host.style, { position: "fixed", left: "0", top: "0", width: "100vw", height: "100vh", zIndex: "2147483647", pointerEvents: "none", overflow: "hidden" });
    const root = host.attachShadow({ mode: "closed" });
    const drag = doc.createElementNS(svgNs, "svg");
    Object.assign(drag.style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", display: "none" });
    const line = doc.createElementNS(svgNs, "line");
    for (const [name, value] of [["stroke", blue], ["stroke-width", "2"], ["stroke-dasharray", "4 3"]]) line.setAttribute(name!, value!);
    drag.append(line);
    const cursor = doc.createElement("div");
    Object.assign(cursor.style, { position: "absolute", left: "50%", top: "50%", width: "0", height: "0", display: "none", transition: "left 150ms ease-out, top 150ms ease-out, opacity 150ms ease-out" });
    const arrow = doc.createElementNS(svgNs, "svg");
    for (const [name, value] of [["width", "20"], ["height", "20"], ["viewBox", "0 0 24 24"], ["fill", "#ffffff"], ["stroke", blue], ["stroke-width", "2"], ["stroke-linejoin", "round"]]) arrow.setAttribute(name!, value!);
    Object.assign(arrow.style, { position: "absolute", left: "-3px", top: "-3px", filter: "drop-shadow(0 1px 1px rgba(0, 0, 0, 0.35))" });
    const path = doc.createElementNS(svgNs, "path");
    path.setAttribute("d", pointerPath);
    arrow.append(path);
    const label = doc.createElement("span");
    Object.assign(label.style, labelStyle, { left: "18px", top: "18px" });
    cursor.append(arrow, label);
    const corner = doc.createElement("span");
    Object.assign(corner.style, labelStyle, { left: "8px", bottom: "8px" });
    root.append(drag, cursor, corner);
    doc.documentElement.append(host);
    layer = { host, cursor, arrow, label, corner, drag, line, timers: [] };
    scope.tauAgentCursor = layer;
  }
  const current = layer;
  current.timers.forEach((timer) => clearTimeout(timer));
  current.timers = [];
  const width = window.innerWidth;
  const height = window.innerHeight;
  const placed = typeof mark.x === "number" && typeof mark.y === "number";
  const ends = typeof mark.toX === "number" && typeof mark.toY === "number";
  current.arrow.setAttribute("stroke", mark.failed ? "#e5484d" : blue);
  if (placed) {
    const x = (ends ? mark.toX! : mark.x!) * width;
    const y = (ends ? mark.toY! : mark.y!) * height;
    Object.assign(current.cursor.style, { display: "block", left: `${x}px`, top: `${y}px`, opacity: "1" });
    current.timers.push(setTimeout(() => { current.cursor.style.opacity = "0.35"; }, timing.activeMs));
  }
  if (placed && ends) {
    for (const [name, value] of [["x1", mark.x! * width], ["y1", mark.y! * height], ["x2", mark.toX! * width], ["y2", mark.toY! * height]] as const) current.line.setAttribute(name, String(value));
    current.drag.style.display = "block";
    current.timers.push(setTimeout(() => { current.drag.style.display = "none"; }, timing.labelMs));
  } else {
    current.drag.style.display = "none";
  }
  const clicked = mark.kind === "click" || mark.kind === "double-click" || mark.kind === "right-click";
  if (placed && clicked) {
    const ping = doc.createElement("span");
    Object.assign(ping.style, { position: "absolute", left: "-10px", top: "-10px", width: "20px", height: "20px", borderRadius: "50%", background: "rgba(47, 129, 247, 0.35)" });
    current.cursor.prepend(ping);
    if (typeof ping.animate === "function") ping.animate([{ transform: "scale(0.4)", opacity: 0.9 }, { transform: "scale(1.8)", opacity: 0 }], { duration: timing.activeMs, easing: "ease-out", fill: "forwards" });
    current.timers.push(setTimeout(() => ping.remove(), timing.activeMs));
  }
  const text = placed ? current.label : current.corner;
  const other = placed ? current.corner : current.label;
  other.style.display = "none";
  if (mark.label) {
    text.textContent = mark.label;
    text.style.display = "block";
    current.timers.push(setTimeout(() => { text.style.display = "none"; }, timing.labelMs));
  } else {
    text.style.display = "none";
  }
  return true;
}

export function previewAgentCursorClear(): boolean {
  const scope = globalThis as unknown as { tauAgentCursor?: { host: HTMLElement; timers: ReturnType<typeof setTimeout>[] } };
  const layer = scope.tauAgentCursor;
  layer?.timers.forEach((timer) => clearTimeout(timer));
  layer?.host.remove();
  delete scope.tauAgentCursor;
  return Boolean(layer);
}

/**
 * While a recording runs: the page's own cursor is hidden and drawn instead,
 * so the video shows one clear pointer; with `clicks` a ring marks each
 * press, with `keys` each key or chord shows at the bottom — except while a
 * password field, an iframe or a custom element (whose field type cannot be
 * read) has focus. Calling it again only changes the options.
 */
export function previewInputOverlay(options: PageInputOptions, pointerPath: string): boolean {
  type Session = { options: PageInputOptions; host: HTMLElement; dispose(): void };
  const scope = globalThis as unknown as { tauInputOverlay?: Session };
  const existing = scope.tauInputOverlay;
  if (existing?.host.isConnected) {
    existing.options = options;
    return true;
  }
  existing?.dispose();
  const doc = document;
  const svgNs = "http://www.w3.org/2000/svg";
  const host = doc.createElement("div");
  host.setAttribute("data-tau-overlay", "recording-input");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, { position: "fixed", left: "0", top: "0", width: "100vw", height: "100vh", zIndex: "2147483646", pointerEvents: "none", overflow: "hidden" });
  const root = host.attachShadow({ mode: "closed" });
  const pointer = doc.createElementNS(svgNs, "svg");
  for (const [name, value] of [["width", "22"], ["height", "22"], ["viewBox", "0 0 24 24"], ["fill", "#111111"], ["stroke", "#ffffff"], ["stroke-width", "1.6"], ["stroke-linejoin", "round"]]) pointer.setAttribute(name!, value!);
  Object.assign(pointer.style, { position: "absolute", left: "0", top: "0", display: "none", filter: "drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4))" });
  const path = doc.createElementNS(svgNs, "path");
  path.setAttribute("d", pointerPath);
  pointer.append(path);
  const keys = doc.createElement("div");
  Object.assign(keys.style, {
    position: "absolute", left: "50%", bottom: "24px", transform: "translateX(-50%)", display: "none", padding: "6px 12px",
    borderRadius: "8px", background: "rgba(20, 20, 20, 0.82)", color: "#ffffff", whiteSpace: "pre",
    font: "600 16px/1.3 ui-sans-serif, -apple-system, BlinkMacSystemFont, sans-serif", letterSpacing: "0.02em",
  });
  root.append(pointer, keys);
  doc.documentElement.append(host);

  // `cursor: none` for the page itself; a constructed sheet, since CSP may refuse a <style>.
  let sheet: CSSStyleSheet | undefined;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync("html, html * { cursor: none !important; }");
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  } catch {
    sheet = undefined;
  }

  const mac = /Mac/u.test(navigator.platform);
  const glyphs: Record<string, string> = {
    Enter: "↵", Tab: "⇥", Backspace: "⌫", Delete: "⌦", Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓",
    ArrowLeft: "←", ArrowRight: "→", " ": "Space",
  };
  const label = (event: KeyboardEvent): string | undefined => {
    if (["Dead", "Process", "Unidentified", ""].includes(event.key)) return undefined;
    const modifiers = [
      event.ctrlKey || event.key === "Control" ? (mac ? "⌃" : "Ctrl") : "",
      event.altKey || event.key === "Alt" ? (mac ? "⌥" : "Alt") : "",
      event.shiftKey || event.key === "Shift" ? (mac ? "⇧" : "Shift") : "",
      event.metaKey || event.key === "Meta" ? (mac ? "⌘" : "Win") : "",
    ].filter(Boolean);
    if (!["Control", "Alt", "Shift", "Meta"].includes(event.key)) modifiers.push(glyphs[event.key] ?? (event.key.length === 1 ? event.key.toUpperCase() : event.key));
    return modifiers.join(mac ? "" : " + ");
  };
  const sensitive = (): boolean => {
    let element: Element | null = doc.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element?.tagName === "IFRAME" || element?.tagName.includes("-") === true || element?.getAttribute("type")?.toLowerCase() === "password";
  };
  let shown = "";
  let lastKeyAt = 0;
  let hideKeys: ReturnType<typeof setTimeout> | undefined;
  const move = (event: MouseEvent) => {
    Object.assign(pointer.style, { display: "block", transform: `translate(${event.clientX - 4}px, ${event.clientY - 3}px)` });
  };
  const leave = () => { pointer.style.display = "none"; };
  const press = (event: MouseEvent) => {
    move(event);
    if (!session.options.clicks) return;
    const ring = doc.createElement("span");
    Object.assign(ring.style, {
      position: "absolute", left: `${event.clientX - 14}px`, top: `${event.clientY - 14}px`, width: "28px", height: "28px",
      borderRadius: "50%", border: "2px solid #2f81f7", background: "rgba(47, 129, 247, 0.18)", boxSizing: "border-box",
    });
    root.append(ring);
    if (typeof ring.animate === "function") ring.animate([{ transform: "scale(0.5)", opacity: 1 }, { transform: "scale(1.4)", opacity: 0 }], { duration: 450, easing: "ease-out", fill: "forwards" });
    setTimeout(() => ring.remove(), 450);
  };
  const key = (event: KeyboardEvent) => {
    if (!session.options.keys) return;
    const text = sensitive() ? undefined : label(event);
    if (!text) return;
    const now = Date.now();
    // Plain letters typed in a row read as a word; anything with a modifier stands alone.
    const plain = text.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    shown = plain && now - lastKeyAt < 900 && shown.length < 24 && !/[⌃⌥⌘]|Ctrl|Alt|Win/u.test(shown) ? shown + text : text;
    lastKeyAt = now;
    keys.textContent = shown;
    keys.style.display = "block";
    if (hideKeys) clearTimeout(hideKeys);
    hideKeys = setTimeout(() => { keys.style.display = "none"; shown = ""; }, 1_400);
  };
  const dispose = () => {
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("mousedown", press, true);
    window.removeEventListener("keydown", key, true);
    doc.documentElement.removeEventListener("mouseleave", leave);
    if (hideKeys) clearTimeout(hideKeys);
    if (sheet) doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((candidate) => candidate !== sheet);
    host.remove();
  };
  const session: Session = { options, host, dispose };
  window.addEventListener("mousemove", move, true);
  window.addEventListener("mousedown", press, true);
  window.addEventListener("keydown", key, true);
  doc.documentElement.addEventListener("mouseleave", leave);
  scope.tauInputOverlay = session;
  return true;
}

export function previewInputOverlayEnd(): boolean {
  const scope = globalThis as unknown as { tauInputOverlay?: { dispose(): void } };
  const session = scope.tauInputOverlay;
  session?.dispose();
  delete scope.tauInputOverlay;
  return Boolean(session);
}
