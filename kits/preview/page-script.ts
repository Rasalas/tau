/**
 * Everything Preview Kit runs *inside* the page. Each function is standalone
 * and reaches nothing from this module, because it travels to the page as
 * `Function.prototype.toString()` and is called there with plain arguments.
 * That is also what lets the tests run it against jsdom.
 */

export interface PreviewTarget {
  ref?: string;
  selector?: string;
  text?: string;
}

export type PreviewFinder = (target: PreviewTarget) => Element | null;

export interface PreviewActionResult {
  ok: boolean;
  detail?: string;
  error?: string;
  /** Where the action landed and the viewport it landed in, CSS pixels: the agent cursor goes there. */
  point?: { x: number; y: number };
  viewport?: { width: number; height: number };
  /** The text went into a password field and must not be shown. */
  sensitive?: boolean;
}

/** `ref` ids are minted by the snapshot; anything else is not one. */
export function isPreviewRef(value: string): boolean {
  return /^e[1-9][0-9]*$/u.test(value);
}

/** Finds the element a tool addressed, by snapshot ref, CSS selector or visible text. */
export function previewFind(target: PreviewTarget): Element | null {
  if (target.ref) return document.querySelector(`[data-tau-ref="${target.ref}"]`);
  if (target.selector) {
    try {
      return document.querySelector(target.selector);
    } catch {
      return null;
    }
  }
  if (!target.text) return null;
  const wanted = target.text.trim().toLowerCase();
  const candidates = Array.from(document.querySelectorAll("a, button, input, select, textarea, summary, label, [role], [onclick]"));
  const named = (element: Element): string => (
    element.getAttribute("aria-label")
    ?? (element as HTMLInputElement).value
    ?? ""
  ).trim() || (element.textContent ?? "").trim();
  const exact = candidates.find((element) => named(element).toLowerCase() === wanted);
  if (exact) return exact;
  const partial = candidates.find((element) => named(element).toLowerCase().includes(wanted));
  if (partial) return partial;
  const all = Array.from(document.querySelectorAll("body *"));
  return all.find((element) => (element.textContent ?? "").trim().toLowerCase() === wanted) ?? null;
}

/**
 * A compact accessibility-flavoured tree of the page: roles, names, values and
 * headings, with a `ref` on everything a tool can act on. Refs are renumbered
 * on every call, so a snapshot is the only thing that makes them valid.
 */
export function previewSnapshot(maxChars: number): string {
  const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "LINK", "META", "SVG"]);
  const interactive = new Set(["link", "button", "textbox", "checkbox", "radio", "combobox"]);
  for (const marked of Array.from(document.querySelectorAll("[data-tau-ref]"))) marked.removeAttribute("data-tau-ref");

  const hidden = (element: Element): boolean => {
    if (element.getAttribute("aria-hidden") === "true" || element.hasAttribute("hidden")) return true;
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    return style?.display === "none" || style?.visibility === "hidden";
  };
  const clip = (value: string, limit: number): string => {
    const text = value.replace(/\s+/gu, " ").trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  };
  const roleOf = (element: Element): string => {
    const explicit = element.getAttribute("role");
    if (explicit === "button" || explicit === "link" || explicit === "checkbox" || explicit === "radio" || explicit === "heading") return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "img") return "image";
    if (/^h[1-6]$/u.test(tag)) return "heading";
    if (element.getAttribute("contenteditable") === "true") return "textbox";
    if (tag !== "input") return "";
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    if (type === "button" || type === "submit" || type === "reset") return "button";
    if (type === "checkbox" || type === "radio") return type;
    if (type === "hidden") return "";
    return "textbox";
  };
  // The accessible name in the order a screen reader would take it.
  const nameOf = (element: Element): string => {
    const labelled = element.getAttribute("aria-label") ?? element.getAttribute("alt");
    if (labelled) return clip(labelled, 60);
    const labels = (element as HTMLInputElement).labels;
    if (labels && labels.length > 0 && labels[0]?.textContent?.trim()) return clip(labels[0].textContent, 60);
    const fallback = element.getAttribute("placeholder") ?? element.getAttribute("title");
    if (fallback) return clip(fallback, 60);
    return clip(element.textContent ?? "", 60);
  };
  const ownText = (element: Element): string => clip(
    Array.from(element.childNodes).filter((node) => node.nodeType === 3).map((node) => node.textContent ?? "").join(" "),
    140,
  );

  const lines: string[] = [];
  let counter = 0;
  const walk = (element: Element, depth: number): void => {
    if (skip.has(element.tagName.toUpperCase()) || hidden(element)) return;
    const role = roleOf(element);
    let childDepth = depth;
    if (role) {
      counter += 1;
      const parts = [`${"  ".repeat(depth)}${role} "${nameOf(element)}"`];
      if (interactive.has(role)) {
        const ref = `e${counter}`;
        element.setAttribute("data-tau-ref", ref);
        parts.push(`[ref=${ref}]`);
      }
      const value = (element as HTMLInputElement).value;
      if (role === "textbox" && typeof value === "string" && value) parts.push(`value="${clip(value, 40)}"`);
      if (role === "checkbox" || role === "radio") parts.push((element as HTMLInputElement).checked ? "checked" : "unchecked");
      if ((element as HTMLInputElement).disabled) parts.push("disabled");
      lines.push(parts.join(" "));
      childDepth = depth + 1;
    } else {
      const text = ownText(element);
      if (text) lines.push(`${"  ".repeat(depth)}text "${text}"`);
    }
    for (const child of Array.from(element.children)) walk(child, childDepth);
  };
  walk(document.body, 0);

  const header = `${document.title || "(untitled)"} — ${document.location.href}`;
  let body = lines.join("\n");
  if (body.length > maxChars) body = `${body.slice(0, maxChars)}\n… snapshot truncated`;
  return `${header}\n${body}`;
}

export function previewClick(find: PreviewFinder, target: PreviewTarget): PreviewActionResult {
  const element = find(target);
  if (!element) return { ok: false, error: "No element matched." };
  const node = element as HTMLElement;
  if (typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "center", inline: "center" });
  if (typeof node.focus === "function") node.focus();
  const box = node.getBoundingClientRect();
  if (typeof node.click === "function") node.click();
  else node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return {
    ok: true,
    detail: `${node.tagName.toLowerCase()} "${(node.getAttribute("aria-label") ?? node.textContent ?? "").trim().slice(0, 60)}"`,
    point: { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

/**
 * React tracks the DOM value it wrote, so assigning `.value` is silently
 * ignored. The prototype's setter plus a bubbling `input` is what a controlled
 * input actually reacts to.
 */
export function previewType(find: PreviewFinder, target: PreviewTarget, text: string, submit: boolean): PreviewActionResult {
  const element = find(target);
  if (!element) return { ok: false, error: "No element matched." };
  const node = element as HTMLInputElement;
  if (typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "center", inline: "nearest" });
  if (typeof node.focus === "function") node.focus();
  const box = node.getBoundingClientRect();
  const landed = {
    point: { x: Math.round(box.left + Math.min(box.width / 2, 24)), y: Math.round(box.top + box.height / 2) },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    ...(node.getAttribute("type")?.toLowerCase() === "password" ? { sensitive: true } : {}),
  };
  if (node.getAttribute("contenteditable") === "true") {
    node.textContent = text;
    node.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (!setter) return { ok: false, error: "Element does not take text." };
    setter.call(node, text);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (submit) {
    const options = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    const accepted = node.dispatchEvent(new KeyboardEvent("keydown", options));
    node.dispatchEvent(new KeyboardEvent("keyup", options));
    const form = node.form;
    if (accepted && form && typeof form.requestSubmit === "function") form.requestSubmit();
  }
  return { ok: true, detail: `typed ${text.length} characters into ${node.tagName.toLowerCase()}`, ...landed };
}

export function previewScroll(find: PreviewFinder, target: PreviewTarget | undefined, dx: number, dy: number): PreviewActionResult {
  const element = target && (target.ref || target.selector) ? find(target) : undefined;
  if (target && (target.ref || target.selector) && !element) return { ok: false, error: "No element matched." };
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  if (element) {
    element.scrollLeft += dx;
    element.scrollTop += dy;
    const box = element.getBoundingClientRect();
    const point = { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
    return { ok: true, detail: `scrolled ${element.tagName.toLowerCase()} to ${element.scrollLeft},${element.scrollTop}`, point, viewport };
  }
  window.scrollBy(dx, dy);
  return { ok: true, detail: `scrolled page to ${Math.round(window.scrollX)},${Math.round(window.scrollY)}`, point: { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) }, viewport };
}

/** True once the page shows what `preview_wait_for` was told to wait for. */
export function previewCondition(text: string | undefined, selector: string | undefined): boolean {
  if (selector) {
    try {
      if (!document.querySelector(selector)) return false;
    } catch {
      return false;
    }
  }
  if (!text) return true;
  const body = document.body;
  const visible = (body.innerText || body.textContent || "").replace(/\s+/gu, " ");
  return visible.toLowerCase().includes(text.replace(/\s+/gu, " ").toLowerCase());
}

/** Source text that runs `fn` in the page with the given arguments. */
export function pageCall(fn: (...args: never[]) => unknown, ...args: unknown[]): string {
  const encoded = args.map((value) => typeof value === "function" ? String(value) : JSON.stringify(value ?? null));
  return `(${String(fn)})(${encoded.join(", ")})`;
}
