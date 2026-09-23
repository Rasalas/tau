import {
  MAX_ACCESSIBILITY_CHARS,
  MAX_ACCESSIBILITY_NODES,
  type SnapShotAccessibility,
  type SnapShotBounds,
  type SnapShotElement,
  type SnapShotElementState,
} from "./protocol.js";

/** The part of an accessibility element this kit reads; the platform client's getters may throw. */
export interface AccessibleElement {
  readonly role: string;
  readonly name: string | null;
  readonly value: string | null;
  readonly description: string | null;
  readonly bounds: SnapShotBounds | null;
  readonly actions: string[];
  readonly enabled: boolean;
  readonly focused: boolean;
  readonly selected: boolean;
  readonly editable: boolean;
  readonly expanded: boolean | null;
  readonly checked: "on" | "off" | "mixed" | null;
  readonly active?: boolean;
  children(): Promise<AccessibleElement[]>;
}

export interface TreeLimits {
  maxNodes?: number;
  maxChars?: number;
  /** A `now()` past which reading stops and what was read so far is kept. */
  deadline: number;
  now?: () => number;
}

/** Actions every element advertises; they say nothing about it. */
const NOISE_ACTIONS = new Set(["focus", "show_menu", "scroll_to_visible", "scroll_into_view", "blur"]);
const SILENT_ROLES = new Set(["group", "unknown", "generic", "none"]);
const TEXT_ROLES = new Set(["static_text", "text"]);

function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Trimmed, without NUL, at most `max` characters, cut before a lone surrogate half. */
export function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replaceAll("\0", "").trim();
  if (!text) return undefined;
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/u.test(text[max - 1] ?? "") ? max - 1 : max;
  return text.slice(0, end).trimEnd();
}

/** A rectangle on the screen as pixels of the image of `window`, or undefined when it falls outside. */
export function imageBounds(bounds: SnapShotBounds | null | undefined, window: SnapShotBounds, image: { width: number; height: number }): SnapShotBounds | undefined {
  if (!bounds || window.width <= 0 || window.height <= 0 || image.width <= 0 || image.height <= 0) return undefined;
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return undefined;
  const scaleX = image.width / window.width;
  const scaleY = image.height / window.height;
  const left = Math.max(0, Math.round((bounds.x - window.x) * scaleX));
  const top = Math.max(0, Math.round((bounds.y - window.y) * scaleY));
  const right = Math.min(image.width, Math.round((bounds.x + bounds.width - window.x) * scaleX));
  const bottom = Math.min(image.height, Math.round((bounds.y + bounds.height - window.y) * scaleY));
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : undefined;
}

function stateOf(element: AccessibleElement): SnapShotElementState | undefined {
  const checked = safe(() => element.checked);
  const expanded = safe(() => element.expanded);
  const state: SnapShotElementState = {
    ...(checked === "on" || checked === "off" || checked === "mixed" ? { checked } : {}),
    ...(safe(() => element.enabled) === false ? { disabled: true as const } : {}),
    ...(safe(() => element.editable) === true ? { editable: true as const } : {}),
    ...(typeof expanded === "boolean" ? { expanded } : {}),
    ...(safe(() => element.focused) === true ? { focused: true as const } : {}),
    ...(safe(() => element.selected) === true ? { selected: true as const } : {}),
  };
  return Object.keys(state).length > 0 ? state : undefined;
}

function nodeOf(element: AccessibleElement, window: SnapShotBounds, image: { width: number; height: number }, root: boolean): SnapShotElement {
  const name = boundedText(safe(() => element.name), 1_000);
  const value = boundedText(safe(() => element.value), 8_000);
  const description = boundedText(safe(() => element.description), 2_000);
  const actions = root ? [] : [...new Set((safe(() => element.actions) ?? [])
    .map((action) => boundedText(action, 100))
    .filter((action): action is string => action !== undefined && !NOISE_ACTIONS.has(action)))].slice(0, 16);
  const bounds = root ? { x: 0, y: 0, width: image.width, height: image.height } : imageBounds(safe(() => element.bounds), window, image);
  const state = root ? undefined : stateOf(element);
  return {
    role: boundedText(safe(() => element.role), 100) ?? "unknown",
    ...(name ? { name } : {}),
    ...(value && value !== name ? { value } : {}),
    ...(description && description !== name && description !== value ? { description } : {}),
    ...(bounds ? { bounds } : {}),
    ...(state ? { state } : {}),
    ...(actions.length > 0 ? { actions } : {}),
    children: [],
  };
}

const says = (node: SnapShotElement): boolean => Boolean(node.name || node.value || node.description || node.state || node.actions);

/**
 * Drops what says nothing: a wrapper group without a name gives way to its
 * children, and a text leaf that repeats its parent's name goes.
 */
export function compact(node: SnapShotElement, parentName?: string, root = true): SnapShotElement[] {
  const children = node.children.flatMap((child) => compact(child, node.name ?? parentName, false));
  if (!root && SILENT_ROLES.has(node.role) && !says(node)) return children;
  if (!root && TEXT_ROLES.has(node.role) && children.length === 0 && !says({ ...node, name: undefined, value: undefined }) && (node.value ?? node.name) === parentName) return [];
  return [{ ...node, children }];
}

export function countNodes(node: SnapShotElement): number {
  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);
}

/**
 * Reads the element tree under one window, depth first, with bounds in the
 * pixels of its image. It stops at the node, character or time limit and
 * keeps what it had; `truncated` says so.
 */
export async function readElementTree(
  window: AccessibleElement,
  windowBounds: SnapShotBounds,
  imageSize: { width: number; height: number },
  limits: TreeLimits,
): Promise<SnapShotAccessibility> {
  const maxNodes = limits.maxNodes ?? MAX_ACCESSIBILITY_NODES;
  const maxChars = limits.maxChars ?? MAX_ACCESSIBILITY_CHARS;
  const now = limits.now ?? Date.now;
  let nodes = 0;
  let chars = 0;
  let truncated = false;
  const full = (): boolean => nodes >= maxNodes || chars >= maxChars || now() >= limits.deadline;

  const visit = async (element: AccessibleElement, root: boolean): Promise<SnapShotElement | undefined> => {
    if (!root && full()) {
      truncated = true;
      return undefined;
    }
    const node = nodeOf(element, windowBounds, imageSize, root);
    const size = JSON.stringify({ ...node, children: undefined }).length + 1;
    if (!root && chars + size > maxChars) {
      truncated = true;
      return undefined;
    }
    nodes += 1;
    chars += size;
    let children: AccessibleElement[];
    try {
      children = await element.children();
    } catch {
      truncated = true;
      return node;
    }
    for (const child of children) {
      const read = await visit(child, false);
      if (!read) break;
      node.children.push(read);
    }
    return node;
  };

  const root = (await visit(window, true))!;
  const [compacted = root] = compact(root);
  return { imageSize, truncated, nodes: countNodes(compacted), root: compacted };
}

/** Of an app's windows, the one titled `title`; the only one; else the active one. */
export function matchWindow<T extends { name: string | null; active?: boolean }>(windows: readonly T[], title: string): T | undefined {
  const wanted = title.trim();
  if (wanted) {
    const titled = windows.filter((window) => (safe(() => window.name) ?? "").trim() === wanted);
    if (titled.length === 1) return titled[0];
    const active = titled.filter((window) => safe(() => window.active) === true);
    if (active.length === 1) return active[0];
    if (titled.length > 1) return undefined;
  }
  if (windows.length === 1) return windows[0];
  const active = windows.filter((window) => safe(() => window.active) === true);
  return active.length === 1 ? active[0] : undefined;
}

/** A few lines to show the user what the model will read: role and label, indented. */
export function outline(root: SnapShotElement, maxLines = 40): string[] {
  const lines: string[] = [];
  const walk = (node: SnapShotElement, depth: number): void => {
    if (lines.length >= maxLines) return;
    const label = node.name ?? node.value ?? node.description;
    lines.push(`${"  ".repeat(depth)}${node.role.replaceAll("_", " ")}${label ? ` “${label.length > 80 ? `${label.slice(0, 79)}…` : label}”` : ""}`);
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return lines;
}
