/**
 * How the panel arranges the host's shells: tabs, each a split tree of panes.
 * The shells live in the host; this is only where the client draws them, so
 * every function is pure and a layout that names a shell the host no longer
 * has is simply reconciled away.
 */

/** `right` puts the new pane beside the old one, `down` below it. */
export type SplitDirection = "right" | "down";

export type PaneNode =
  | { kind: "pane"; id: string }
  | { kind: "split"; direction: SplitDirection; children: PaneNode[] };

export interface TerminalGroup {
  /** Stable while the tab lives; not a shell id, since the first shell may close. */
  id: string;
  root: PaneNode;
  /** The pane that has, or last had, the keyboard. */
  focused: string;
}

export interface TerminalLayout {
  groups: TerminalGroup[];
  /** The tab the panel shows. */
  active?: string;
  /** Shells drawn as stage tabs; the panel leaves them alone until they come back. */
  onStage: string[];
}

export const EMPTY_LAYOUT: TerminalLayout = { groups: [], onStage: [] };

export function pane(id: string): PaneNode {
  return { kind: "pane", id };
}

/** Every shell in the tree, in reading order. */
export function paneIds(node: PaneNode): string[] {
  return node.kind === "pane" ? [node.id] : node.children.flatMap(paneIds);
}

export function hasPane(node: PaneNode, id: string): boolean {
  return node.kind === "pane" ? node.id === id : node.children.some((child) => hasPane(child, id));
}

/**
 * Splits `target` and puts `id` after it. Splitting in the direction the
 * target's parent already runs adds a sibling instead of nesting, so three
 * panes side by side are one row of three, not a row inside a row.
 */
export function splitPane(node: PaneNode, target: string, id: string, direction: SplitDirection): PaneNode {
  if (node.kind === "pane") {
    return node.id === target ? { kind: "split", direction, children: [node, pane(id)] } : node;
  }
  const index = node.children.findIndex((child) => child.kind === "pane" && child.id === target);
  if (index !== -1 && node.direction === direction) {
    return { ...node, children: [...node.children.slice(0, index + 1), pane(id), ...node.children.slice(index + 1)] };
  }
  return { ...node, children: node.children.map((child) => splitPane(child, target, id, direction)) };
}

/** Takes a pane out; a split left with one child becomes that child, and nothing left is `undefined`. */
export function removePane(node: PaneNode, id: string): PaneNode | undefined {
  if (node.kind === "pane") return node.id === id ? undefined : node;
  const children = node.children
    .map((child) => removePane(child, id))
    .filter((child): child is PaneNode => child !== undefined)
    // A child split that now runs the same way as this one merges into it.
    .flatMap((child) => child.kind === "split" && child.direction === node.direction ? child.children : [child]);
  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0];
  return { ...node, children };
}

/** The pane `step` places after `id` in reading order, wrapping around. */
export function nextPane(node: PaneNode, id: string, step: 1 | -1 = 1): string {
  const ids = paneIds(node);
  const index = ids.indexOf(id);
  if (index === -1) return ids[0] ?? id;
  return ids[(index + step + ids.length) % ids.length]!;
}

function groupOf(layout: TerminalLayout, id: string): TerminalGroup | undefined {
  return layout.groups.find((group) => hasPane(group.root, id));
}

/** The groups replaced; `active` stays if it still names a tab, else the last tab is. */
function withGroups(layout: TerminalLayout, groups: TerminalGroup[], active = layout.active): TerminalLayout {
  const kept = active && groups.some((group) => group.id === active) ? active : groups.at(-1)?.id;
  const { active: _previous, ...rest } = layout;
  return kept ? { ...rest, groups, active: kept } : { ...rest, groups };
}

/** Takes a shell out of whichever tab holds it; an emptied tab goes, and the tab beside it becomes active. */
export function detachPane(layout: TerminalLayout, id: string): TerminalLayout {
  const index = layout.groups.findIndex((group) => hasPane(group.root, id));
  if (index === -1) return layout;
  const group = layout.groups[index]!;
  const root = removePane(group.root, id);
  if (!root) {
    const groups = layout.groups.filter((entry) => entry.id !== group.id);
    const neighbour = groups[Math.min(index, groups.length - 1)];
    return withGroups(layout, groups, layout.active === group.id ? neighbour?.id : layout.active);
  }
  const ids = paneIds(group.root);
  const at = ids.indexOf(id);
  const focused = group.focused === id ? ids[at - 1] ?? ids[at + 1]! : group.focused;
  const next = { ...group, root, focused: hasPane(root, focused) ? focused : paneIds(root)[0]! };
  return { ...layout, groups: layout.groups.map((entry) => entry.id === group.id ? next : entry) };
}

/** A shell in a tab of its own, made active. */
export function addGroup(layout: TerminalLayout, id: string, groupId = `group-${id}`): TerminalLayout {
  const detached = detachPane({ ...layout, onStage: layout.onStage.filter((entry) => entry !== id) }, id);
  return { ...detached, groups: [...detached.groups, { id: groupId, root: pane(id), focused: id }], active: groupId };
}

/** A new shell beside `target`, focused; without a target it gets a tab of its own. */
export function splitAt(layout: TerminalLayout, target: string | undefined, id: string, direction: SplitDirection): TerminalLayout {
  const detached = detachPane(layout, id);
  const group = target ? groupOf(detached, target) : undefined;
  if (!group || !target) return addGroup(detached, id);
  const next = { ...group, root: splitPane(group.root, target, id, direction), focused: id };
  return { ...detached, groups: detached.groups.map((entry) => entry.id === group.id ? next : entry), active: group.id };
}

/** The pane that has the keyboard, and its tab active. */
export function focusPane(layout: TerminalLayout, id: string): TerminalLayout {
  const group = groupOf(layout, id);
  if (!group || (group.focused === id && layout.active === group.id)) return layout;
  return { ...layout, active: group.id, groups: layout.groups.map((entry) => entry.id === group.id ? { ...entry, focused: id } : entry) };
}

/** The focused pane of the active tab, if the panel shows any. */
export function focusedPane(layout: TerminalLayout): string | undefined {
  return layout.groups.find((group) => group.id === layout.active)?.focused;
}

/** Focus moves through the active tab's panes, wrapping around. */
export function focusNext(layout: TerminalLayout, step: 1 | -1 = 1): TerminalLayout {
  const group = layout.groups.find((entry) => entry.id === layout.active);
  if (!group) return layout;
  return focusPane(layout, nextPane(group.root, group.focused, step));
}

/** The shell leaves the panel for a stage tab; it keeps running in the host. */
export function moveToStage(layout: TerminalLayout, id: string): TerminalLayout {
  const detached = detachPane(layout, id);
  return detached.onStage.includes(id) ? detached : { ...detached, onStage: [...detached.onStage, id] };
}

/** Its stage tab closed: the shell comes back to the panel as a tab of its own. */
export function returnFromStage(layout: TerminalLayout, id: string): TerminalLayout {
  if (!layout.onStage.includes(id)) return layout;
  return addGroup({ ...layout, onStage: layout.onStage.filter((entry) => entry !== id) }, id);
}

/**
 * Brings a layout in line with the shells the host holds: panes of shells
 * that are gone leave, and a shell no tab and no stage tab draws gets a tab
 * of its own — unless it is `held`, one a split is about to place.
 */
export function reconcileLayout(layout: TerminalLayout, sessions: readonly string[], held: ReadonlySet<string> = new Set()): TerminalLayout {
  const live = new Set(sessions);
  let next: TerminalLayout = { ...layout, onStage: layout.onStage.filter((id) => live.has(id)) };
  for (const group of layout.groups) {
    for (const id of paneIds(group.root)) if (!live.has(id)) next = detachPane(next, id);
  }
  const placed = new Set([...next.groups.flatMap((group) => paneIds(group.root)), ...next.onStage]);
  for (const id of sessions) {
    if (!placed.has(id) && !held.has(id)) next = addGroup(next, id);
  }
  return next;
}

/** A layout read back from storage, or the empty one when it does not parse. */
export function parseLayout(value: unknown): TerminalLayout {
  const raw = value as Partial<TerminalLayout> | null;
  if (!raw || !Array.isArray(raw.groups) || !Array.isArray(raw.onStage)) return EMPTY_LAYOUT;
  const groups = raw.groups.filter((group): group is TerminalGroup => Boolean(group && typeof group.id === "string"
    && typeof group.focused === "string" && isNode(group.root)));
  return withGroups({ groups: [], onStage: raw.onStage.filter((id): id is string => typeof id === "string") }, groups, typeof raw.active === "string" ? raw.active : undefined);
}

function isNode(value: unknown): value is PaneNode {
  const node = value as Partial<PaneNode> | null;
  if (node?.kind === "pane") return typeof (node as { id?: unknown }).id === "string";
  if (node?.kind !== "split") return false;
  const split = node as { direction?: unknown; children?: unknown };
  return (split.direction === "right" || split.direction === "down") && Array.isArray(split.children) && split.children.length > 0 && split.children.every(isNode);
}
