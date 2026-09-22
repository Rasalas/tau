/**
 * The two modes the user drives inside the page: picking an element and
 * annotating the page. Like `page-script.ts`, every function travels to the
 * page as source text and reaches nothing from this module; they run in an
 * isolated world, so the page's own scripts cannot see their state.
 */

export interface PreviewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a click in pick mode answers with; `rect` is in the viewport's CSS pixels. */
export interface PreviewPickedElement {
  url: string;
  title: string;
  selector: string;
  tag: string;
  text: string;
  rect: PreviewBox;
  html: string;
  viewport: { width: number; height: number };
}

export type PreviewPickPoll =
  | { state: "armed" }
  | { state: "cancelled" }
  | { state: "missing" }
  | { state: "done"; element: unknown };

export type PreviewAnnotationTool = "rect" | "arrow" | "note";

/** One mark on the page; `x`/`y` is where its number is drawn. */
export interface PreviewAnnotationItem {
  n: number;
  kind: PreviewAnnotationTool;
  x: number;
  y: number;
  width?: number;
  height?: number;
  toX?: number;
  toY?: number;
  note: string;
}

export interface PreviewAnnotationResult {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  items: PreviewAnnotationItem[];
}

/** The shortest selector that names this element alone, walking up from it. */
export function previewSelector(element: Element): string {
  const doc = element.ownerDocument;
  const escape = (value: string): string => typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/[^a-zA-Z0-9_-]/gu, (character) => `\\${character}`);
  const unique = (selector: string): boolean => {
    try {
      return doc.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  };
  const parts: string[] = [];
  for (let node: Element | null = element; node && node.tagName.toLowerCase() !== "html"; node = node.parentElement) {
    const tag = node.tagName.toLowerCase();
    if (node.id && unique(`#${escape(node.id)}`)) {
      parts.unshift(`#${escape(node.id)}`);
      return parts.join(" > ");
    }
    let part = tag;
    const classes = Array.from(node.classList).filter((name) => /^[a-zA-Z][\w-]{0,40}$/u.test(name)).slice(0, 2);
    part += classes.map((name) => `.${escape(name)}`).join("");
    const parent: Element | null = node.parentElement;
    const current = node;
    if (parent) {
      const same = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    if (tag === "body" || unique(parts.join(" > "))) break;
  }
  return parts.join(" > ");
}

/** Selector, text, box and a trimmed copy of the markup: what the agent is told about a picked element. */
export function previewDescribe(element: Element, selectorOf: (element: Element) => string): PreviewPickedElement {
  const clip = (value: string, limit: number): string => value.length > limit ? `${value.slice(0, limit)}…` : value;
  const box = element.getBoundingClientRect();
  const visible = (element as HTMLElement).innerText;
  const text = (typeof visible === "string" ? visible : element.textContent ?? "").replace(/\s+/gu, " ").trim();
  return {
    url: element.ownerDocument.location?.href ?? "",
    title: element.ownerDocument.title,
    selector: selectorOf(element),
    tag: element.tagName.toLowerCase(),
    text: clip(text, 500),
    rect: { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) },
    html: clip(element.outerHTML.replace(/\s+/gu, " "), 1_500),
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

/**
 * Pick mode: a highlight follows the pointer, a click takes the element under
 * it, Escape gives up. Every pointer event is swallowed so the page does not
 * act on the click. The answer waits in the world's own global for the poll.
 */
export function previewPickArm(describe: typeof previewDescribe, selectorOf: (element: Element) => string): boolean {
  type Session = { state: "armed" | "done" | "cancelled"; element?: unknown; dispose(): void };
  const scope = globalThis as unknown as { tauPreviewPick?: Session };
  scope.tauPreviewPick?.dispose();
  const doc = document;
  const top = "2147483647";
  const box = doc.createElement("div");
  const label = doc.createElement("div");
  Object.assign(box.style, {
    position: "fixed", zIndex: top, pointerEvents: "none", display: "none", boxSizing: "border-box",
    border: "2px solid #2f81f7", background: "rgba(47, 129, 247, 0.14)", borderRadius: "2px",
  });
  Object.assign(label.style, {
    position: "fixed", zIndex: top, pointerEvents: "none", display: "none", whiteSpace: "nowrap",
    maxWidth: "70vw", overflow: "hidden", textOverflow: "ellipsis", padding: "2px 6px", borderRadius: "4px",
    font: "11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace", background: "#1f2328", color: "#ffffff",
  });
  doc.documentElement.append(box, label);

  const show = (element: Element) => {
    const rect = element.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    label.textContent = `${selectorOf(element)}  ${Math.round(rect.width)}×${Math.round(rect.height)}`;
    const above = rect.top > 24;
    Object.assign(label.style, { display: "block", left: `${Math.max(0, rect.left)}px`, top: above ? `${rect.top - 22}px` : `${rect.bottom + 4}px` });
  };
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };
  const target = (event: Event): Element | null => event.target instanceof Element ? event.target : null;
  const move = (event: Event) => {
    const element = target(event);
    if (element) show(element);
  };
  const click = (event: Event) => {
    swallow(event);
    const element = target(event);
    if (!element) return;
    session.element = describe(element, selectorOf);
    session.state = "done";
    dispose();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    swallow(event);
    session.state = "cancelled";
    dispose();
  };
  const swallowed = ["pointerdown", "mousedown", "pointerup", "mouseup", "auxclick", "dblclick", "contextmenu"];
  const dispose = () => {
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("click", click, true);
    window.removeEventListener("keydown", key, true);
    for (const type of swallowed) window.removeEventListener(type, swallow, true);
    box.remove();
    label.remove();
  };
  const session: Session = { state: "armed", dispose };
  window.addEventListener("mousemove", move, true);
  window.addEventListener("click", click, true);
  window.addEventListener("keydown", key, true);
  for (const type of swallowed) window.addEventListener(type, swallow, true);
  scope.tauPreviewPick = session;
  return true;
}

/**
 * Where pick mode stands. A settled pick is taken out of the page, and the
 * answer waits for a painted frame so a capture right after it shows the page
 * without the highlight. A navigation took the whole world: `missing`.
 */
export function previewPickPoll(): Promise<PreviewPickPoll> {
  const scope = globalThis as unknown as { tauPreviewPick?: { state: "armed" | "done" | "cancelled"; element?: unknown } };
  const session = scope.tauPreviewPick;
  if (!session) return Promise.resolve({ state: "missing" });
  if (session.state === "armed") return Promise.resolve({ state: "armed" });
  delete scope.tauPreviewPick;
  const answer: PreviewPickPoll = session.state === "done" ? { state: "done", element: session.element } : { state: "cancelled" };
  return new Promise((resolve) => {
    const done = () => resolve(answer);
    // A hidden page paints no frames; the timer keeps the answer from waiting on one.
    setTimeout(done, 150);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(done));
  });
}

export function previewPickCancel(): boolean {
  const scope = globalThis as unknown as { tauPreviewPick?: { dispose(): void } };
  const session = scope.tauPreviewPick;
  session?.dispose();
  delete scope.tauPreviewPick;
  return Boolean(session);
}

/**
 * Annotate mode: a layer over the page where a drag draws a rectangle or an
 * arrow and a click drops a note. Each mark gets a number and a note field; a
 * second call only switches the tool.
 */
export function previewAnnotateStart(tool: PreviewAnnotationTool): boolean {
  type Item = PreviewAnnotationItem & { shape?: Element; field?: HTMLInputElement; caption?: HTMLElement };
  type Session = { tool: PreviewAnnotationTool; items: Item[]; root: HTMLElement; commit(): void; dispose(): void };
  const scope = globalThis as unknown as { tauPreviewAnnotate?: Session };
  const existing = scope.tauPreviewAnnotate;
  if (existing?.root.isConnected) {
    existing.tool = tool;
    return true;
  }
  existing?.dispose();

  const doc = document;
  const svgNs = "http://www.w3.org/2000/svg";
  const red = "#e5484d";
  const root = doc.createElement("div");
  root.setAttribute("data-tau-annotate", "");
  Object.assign(root.style, {
    position: "fixed", left: "0", top: "0", right: "0", bottom: "0", zIndex: "2147483647",
    cursor: "crosshair", background: "rgba(0, 0, 0, 0.04)", userSelect: "none",
  });
  const svg = doc.createElementNS(svgNs, "svg");
  Object.assign((svg as SVGElement).style, { position: "absolute", left: "0", top: "0", width: "100%", height: "100%", overflow: "visible" });
  const defs = doc.createElementNS(svgNs, "defs");
  const marker = doc.createElementNS(svgNs, "marker");
  for (const [name, value] of [["id", "tau-arrowhead"], ["markerWidth", "10"], ["markerHeight", "8"], ["refX", "9"], ["refY", "4"], ["orient", "auto"]]) marker.setAttribute(name!, value!);
  const head = doc.createElementNS(svgNs, "path");
  head.setAttribute("d", "M0,0 L10,4 L0,8 z");
  head.setAttribute("fill", red);
  marker.append(head);
  defs.append(marker);
  svg.append(defs);
  root.append(svg);
  doc.documentElement.append(root);

  const session: Session = { tool, items: [], root, commit, dispose };
  let drawing: { item: Item; startX: number; startY: number } | undefined;

  const badge = (item: Item) => {
    const mark = doc.createElement("div");
    mark.textContent = String(item.n);
    Object.assign(mark.style, {
      position: "absolute", left: `${item.x - 10}px`, top: `${item.y - 10}px`, width: "20px", height: "20px",
      borderRadius: "10px", background: red, color: "#ffffff", font: "bold 11px/20px system-ui, sans-serif",
      textAlign: "center", pointerEvents: "none",
    });
    root.append(mark);
  };
  const place = (item: Item) => {
    if (item.kind === "rect" && item.shape) {
      const x = Math.min(item.x, item.toX ?? item.x);
      const y = Math.min(item.y, item.toY ?? item.y);
      item.shape.setAttribute("x", String(x));
      item.shape.setAttribute("y", String(y));
      item.shape.setAttribute("width", String(Math.abs((item.toX ?? item.x) - item.x)));
      item.shape.setAttribute("height", String(Math.abs((item.toY ?? item.y) - item.y)));
    } else if (item.kind === "arrow" && item.shape) {
      item.shape.setAttribute("x1", String(item.x));
      item.shape.setAttribute("y1", String(item.y));
      item.shape.setAttribute("x2", String(item.toX ?? item.x));
      item.shape.setAttribute("y2", String(item.toY ?? item.y));
    }
  };
  const settle = (item: Item) => {
    if (item.kind === "rect") {
      const x = Math.min(item.x, item.toX ?? item.x);
      const y = Math.min(item.y, item.toY ?? item.y);
      item.width = Math.abs((item.toX ?? item.x) - item.x);
      item.height = Math.abs((item.toY ?? item.y) - item.y);
      item.x = x;
      item.y = y;
      delete item.toX;
      delete item.toY;
    }
  };
  const caption = (item: Item, text: string) => {
    item.note = text.trim();
    // Chromium blurs a focused field it removes; clearing the reference first keeps that blur out.
    const field = item.field;
    item.field = undefined;
    field?.remove();
    if (!item.note) return;
    const note = doc.createElement("div");
    note.textContent = `${item.n}. ${item.note}`;
    Object.assign(note.style, {
      position: "absolute", left: `${item.x + 14}px`, top: `${item.y + 12}px`, maxWidth: "280px",
      padding: "3px 7px", borderRadius: "5px", background: "#ffffff", color: "#1f2328",
      border: `1.5px solid ${red}`, font: "12px/1.4 system-ui, sans-serif", pointerEvents: "none",
      boxShadow: "0 1px 4px rgba(0, 0, 0, 0.2)",
    });
    item.caption = note;
    root.append(note);
  };
  const ask = (item: Item) => {
    const field = doc.createElement("input");
    field.placeholder = `Note ${item.n} (Enter)`;
    Object.assign(field.style, {
      position: "absolute", left: `${item.x + 14}px`, top: `${item.y + 12}px`, width: "220px",
      padding: "4px 7px", borderRadius: "5px", border: `1.5px solid ${red}`, background: "#ffffff",
      color: "#1f2328", font: "12px system-ui, sans-serif", outline: "none", cursor: "text",
    });
    field.addEventListener("mousedown", (event) => event.stopPropagation());
    field.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") caption(item, field.value);
      if (event.key === "Escape") caption(item, "");
    });
    field.addEventListener("blur", () => { if (item.field === field) caption(item, field.value); });
    item.field = field;
    root.append(field);
    field.focus();
  };
  const add = (kind: PreviewAnnotationTool, x: number, y: number): Item => {
    for (const open of session.items) if (open.field) caption(open, open.field.value);
    const item: Item = { n: session.items.length + 1, kind, x, y, note: "" };
    if (kind === "rect" || kind === "arrow") {
      const shape = doc.createElementNS(svgNs, kind === "rect" ? "rect" : "line");
      shape.setAttribute("stroke", red);
      shape.setAttribute("stroke-width", "3");
      shape.setAttribute("fill", kind === "rect" ? "rgba(229, 72, 77, 0.08)" : "none");
      if (kind === "arrow") shape.setAttribute("marker-end", "url(#tau-arrowhead)");
      svg.append(shape);
      item.shape = shape;
      item.toX = x;
      item.toY = y;
      place(item);
    }
    session.items.push(item);
    return item;
  };
  const down = (event: MouseEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const item = add(session.tool, event.clientX, event.clientY);
    if (session.tool === "note") {
      badge(item);
      ask(item);
      return;
    }
    drawing = { item, startX: event.clientX, startY: event.clientY };
  };
  const move = (event: MouseEvent) => {
    if (!drawing) return;
    drawing.item.toX = event.clientX;
    drawing.item.toY = event.clientY;
    place(drawing.item);
  };
  const up = (event: MouseEvent) => {
    if (!drawing) return;
    const { item, startX, startY } = drawing;
    drawing = undefined;
    item.toX = event.clientX;
    item.toY = event.clientY;
    place(item);
    // A click without a drag is not a mark.
    if (Math.hypot(event.clientX - startX, event.clientY - startY) < 6) {
      item.shape?.remove();
      session.items.pop();
      return;
    }
    settle(item);
    badge(item);
    ask(item);
  };
  function commit(): void {
    for (const item of session.items) if (item.field) caption(item, item.field.value);
    root.style.background = "transparent";
  }
  function dispose(): void {
    window.removeEventListener("mousemove", move, true);
    window.removeEventListener("mouseup", up, true);
    root.remove();
    if (scope.tauPreviewAnnotate === session) delete scope.tauPreviewAnnotate;
  }
  root.addEventListener("mousedown", down);
  window.addEventListener("mousemove", move, true);
  window.addEventListener("mouseup", up, true);
  scope.tauPreviewAnnotate = session;
  return true;
}

/**
 * Commits every open note and answers with the marks. The layer stays, so the
 * capture that follows shows the page with them; the answer waits for a
 * painted frame for the same reason. No layer: `null`.
 */
export function previewAnnotateCollect(): Promise<PreviewAnnotationResult | null> {
  type Session = { items: Array<PreviewAnnotationItem & Record<string, unknown>>; commit(): void };
  const session = (globalThis as unknown as { tauPreviewAnnotate?: Session }).tauPreviewAnnotate;
  if (!session) return Promise.resolve(null);
  session.commit();
  const items = session.items.map((item) => {
    const plain: PreviewAnnotationItem = { n: item.n, kind: item.kind, x: Math.round(item.x), y: Math.round(item.y), note: item.note };
    if (item.width !== undefined) plain.width = Math.round(item.width);
    if (item.height !== undefined) plain.height = Math.round(item.height);
    if (item.toX !== undefined) plain.toX = Math.round(item.toX);
    if (item.toY !== undefined) plain.toY = Math.round(item.toY);
    return plain;
  });
  const answer: PreviewAnnotationResult = {
    url: document.location?.href ?? "",
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    items,
  };
  return new Promise((resolve) => {
    const done = () => resolve(answer);
    setTimeout(done, 150);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(done));
  });
}

export function previewAnnotateEnd(): boolean {
  const session = (globalThis as unknown as { tauPreviewAnnotate?: { dispose(): void } }).tauPreviewAnnotate;
  session?.dispose();
  return Boolean(session);
}
