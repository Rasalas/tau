import { openOverlays } from "./keybinding-context";

/** Core areas use 10..50. A panel normally belongs to Stage, rather than adding a stop. */
export interface FocusAreaContribution {
  id: string;
  order: number;
  label: string | (() => string);
  root(): HTMLElement | null | undefined;
  target?(): HTMLElement | null | undefined;
  visible?(): boolean;
}

export function focusVisible(element: HTMLElement | null | undefined): element is HTMLElement {
  if (!element?.isConnected || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  if (typeof element.checkVisibility === "function" && !element.checkVisibility({ checkVisibilityCSS: true })) return false;
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}
const first = (selector: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(selector)].find(focusVisible);
const standardTarget = (root: HTMLElement | null | undefined) => root && first('textarea:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), [aria-current="page"], [aria-selected="true"], button:not(:disabled), [tabindex="0"]', root) || root;

/** Settings is a page drawn as a dialog; dialogs inside it still keep the keyboard. */
export function focusAreaBlocked(): boolean {
  return openOverlays().some((element) => !element.matches('.settings-screen, [data-app-page], .thread-card:not([aria-modal="true"])'));
}

function coreAreas(): FocusAreaContribution[] {
  const area = (id: string, order: number, label: FocusAreaContribution["label"], selector: string, target?: string): FocusAreaContribution => ({
    id, order, label, root: () => first(selector),
    target: () => { const root = first(selector); return target ? (root && first(target, root)) ?? root : standardTarget(root); },
  });
  const threads = area("threads", 10, "Threads", '.session-list[aria-label="Threads"]');
  threads.target = () => { const root = threads.root(); return root ? first('.thread-main[aria-current="page"]', root) ?? first('.thread-main[tabindex="0"]', root) ?? first('.thread-main', root) ?? root : undefined; };
  const settings = first(".settings-screen");
  if (settings) return [threads,
    area("settings-sections", 20, "Settings sections", ".settings-nav", '[aria-current="page"], input, button'),
    area("settings-section", 30, () => first(".settings-topbar-title")?.textContent ?? "Settings", ".settings-main"),
  ];
  if (first("[data-app-page]")) return [threads, area("page", 20, "Page", "[data-app-page]")];
  return [threads,
    area("conversation", 20, "Conversation", ".conversation-column .transcript", ".transcript"),
    area("message", 30, "Message", '.conversation-column .composer, .conversation-column .composer-surface', 'textarea:not(:disabled), [contenteditable="true"]'),
    { ...area("notifications", 40, () => `Notifications, ${document.querySelectorAll(".toast-item").length}`, ".toast-stack", ".toast-item"), visible: () => !!first(".toast-item") },
    area("stage", 50, () => { const title = first('.stage-tab[aria-selected="true"] .stage-tab-label')?.textContent; return title ? `Stage, ${title}` : "Stage"; }, ".stage", '[role="tab"][aria-selected="true"]'),
  ];
}

export class FocusAreaRing {
  private remembered = new Map<string, HTMLElement>();
  private previous: HTMLElement | undefined;
  private previousArea: string | undefined;
  private announcement: HTMLElement;
  private lastArea: string | undefined;
  private lastElement: HTMLElement | undefined;
  constructor(private extra: () => readonly FocusAreaContribution[] = () => []) {
    this.announcement = document.createElement("div");
    this.announcement.setAttribute("role", "status");
    this.announcement.setAttribute("aria-live", "polite");
    Object.assign(this.announcement.style, { position: "fixed", width: "1px", height: "1px", overflow: "hidden", clipPath: "inset(50%)" });
    document.body.append(this.announcement);
    document.addEventListener("focusin", this.remember);
  }
  private areas = () => [...coreAreas(), ...this.extra()].filter((area) => area.visible?.() !== false && focusVisible(area.root())).sort((a, b) => a.order - b.order);
  private remember = (event: FocusEvent) => {
    if (!(event.target instanceof HTMLElement)) return;
    const area = this.areas().find((entry) => entry.root()?.contains(event.target as Node));
    if (!area) return;
    if (area.id === "notifications" && this.lastArea && this.lastArea !== "notifications") {
      this.previous = this.lastElement; this.previousArea = this.lastArea;
    }
    this.remembered.set(area.id, event.target);
    this.lastArea = area.id; this.lastElement = event.target;
  };
  move(direction: 1 | -1): boolean {
    if (document.body.dataset.profile === "compact" || focusAreaBlocked()) return false;
    const areas = this.areas();
    if (!areas.length) return false;
    const active = document.activeElement;
    const current = areas.findIndex((area) => area.root()?.contains(active));
    const index = current < 0 ? (direction > 0 ? 0 : areas.length - 1) : (current + direction + areas.length) % areas.length;
    const next = areas[index]!;
    const root = next.root();
    const held = this.remembered.get(next.id);
    const target = focusVisible(held) && root?.contains(held) ? held : next.target?.() ?? standardTarget(root);
    if (!target || !focusVisible(target)) return false;
    if (next.id === "notifications" && current >= 0 && areas[current]!.id !== "notifications") {
      this.previous = active instanceof HTMLElement ? active : undefined;
      this.previousArea = areas[current]!.id;
    }
    if (!target.hasAttribute("tabindex") && !target.matches("button, input, textarea, select, a[href], [contenteditable]")) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    this.announcement.textContent = typeof next.label === "function" ? next.label() : next.label;
    return true;
  }
  escapeNotifications(): boolean {
    if (focusAreaBlocked() || !document.activeElement?.closest(".toast-stack")) return false;
    const area = this.areas().find((entry) => entry.id === this.previousArea);
    const target = focusVisible(this.previous) ? this.previous : area?.target?.() ?? standardTarget(area?.root());
    if (!target || !focusVisible(target)) return false;
    if (!target.hasAttribute("tabindex") && !target.matches("button, input, textarea, select, a[href], [contenteditable]")) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    if (area) this.announcement.textContent = typeof area.label === "function" ? area.label() : area.label;
    return true;
  }
  dispose(): void { document.removeEventListener("focusin", this.remember); this.announcement.remove(); }
}

let ring: FocusAreaRing | undefined;
/** The runtime commands use the same ring as F6. */
export function moveFocusArea(direction: 1 | -1): void {
  // A palette command runs before its dialog closes. Chords already yield to the palette.
  if (document.querySelector(".command-palette")) requestAnimationFrame(() => ring?.move(direction));
  else ring?.move(direction);
}
export function installFocusAreas(extra: () => readonly FocusAreaContribution[]): () => void {
  const current = new FocusAreaRing(extra);
  ring = current;
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !event.defaultPrevented && current.escapeNotifications()) { event.preventDefault(); event.stopPropagation(); }
  };
  window.addEventListener("keydown", escape, true);
  return () => { window.removeEventListener("keydown", escape, true); current.dispose(); if (ring === current) ring = undefined; };
}
