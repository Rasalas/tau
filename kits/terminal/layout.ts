/**
 * How the kit arranges the host's shells: panel tabs and stage tabs, each a
 * split tree of panes. The shells live in the host; this is only where the
 * client draws them, so every function is pure and a layout that names a
 * shell the host no longer has is simply reconciled away.
 */

/** `right` puts the new pane beside the old one, `down` below it. */
export type SplitDirection = "right" | "down";

export type PaneNode =
  | { kind: "pane"; id: string }
  | {
    kind: "split";
    direction: SplitDirection;
    children: PaneNode[];
    /** Each child's share of the split, summing to 1; absent until the user drags a divider. */
    sizes?: number[];
  };

export interface TerminalGroup {
  /** Stable while the tab lives; not a shell id, since the first shell may close. A stage group's id is its tab's `id` param. */
  id: string;
  root: PaneNode;
  /** The pane that has, or last had, the keyboard. */
  focused: string;
}

export interface TerminalLayout {
  /** The panel's tabs. */
  groups: TerminalGroup[];
  /** The tab the panel shows. */
  active?: string;
  /** Stage tabs, one group each; the panel leaves their shells alone until they come back. */
  stage: TerminalGroup[];
}

export const EMPTY_LAYOUT: TerminalLayout = { groups: [], stage: [] };

/** The smallest share a pane keeps when a divider is dragged. */
export const MIN_PANE_SHARE = 0.1;

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

/** Each child's share, even when the split was never resized. */
export function splitShares(node: Extract<PaneNode, { kind: "split" }>): number[] {
  const count = node.children.length;
  return node.sizes?.length === count ? node.sizes : node.children.map(() => 1 / count);
}

function normalized(shares: readonly number[]): number[] {
  const total = shares.reduce((sum, share) => sum + share, 0);
  if (Math.abs(total - 1) < 1e-9) return [...shares];
  return total > 0 ? shares.map((share) => share / total) : shares.map(() => 1 / shares.length);
}

function split(direction: SplitDirection, children: PaneNode[], sizes?: number[]): PaneNode {
  return sizes ? { kind: "split", direction, children, sizes } : { kind: "split", direction, children };
}

/**
 * Splits `target` and puts `id` after it. Splitting in the direction the
 * target's parent already runs adds a sibling instead of nesting, so three
 * panes side by side are one row of three, not a row inside a row. A sized
 * split halves the target's share between it and the new pane.
 */
export function splitPane(node: PaneNode, target: string, id: string, direction: SplitDirection): PaneNode {
  if (node.kind === "pane") {
    return node.id === target ? split(direction, [node, pane(id)]) : node;
  }
  const index = node.children.findIndex((child) => child.kind === "pane" && child.id === target);
  if (index !== -1 && node.direction === direction) {
    const children = [...node.children.slice(0, index + 1), pane(id), ...node.children.slice(index + 1)];
    const shares = node.sizes ? splitShares(node) : undefined;
    const sizes = shares ? [...shares.slice(0, index), shares[index]! / 2, shares[index]! / 2, ...shares.slice(index + 1)] : undefined;
    return split(node.direction, children, sizes);
  }
  return { ...node, children: node.children.map((child) => splitPane(child, target, id, direction)) };
}

/**
 * Takes a pane out; a split left with one child becomes that child, and
 * nothing left is `undefined`. The removed pane's share goes to the others in
 * proportion, so the panes the user sized keep their proportions.
 */
export function removePane(node: PaneNode, id: string): PaneNode | undefined {
  if (node.kind === "pane") return node.id === id ? undefined : node;
  const shares = splitShares(node);
  let sized = node.sizes !== undefined;
  const kept: Array<{ child: PaneNode; share: number }> = [];
  node.children.forEach((original, index) => {
    const child = removePane(original, id);
    if (!child) return;
    // A child split that now runs the same way as this one merges into it.
    if (child.kind === "split" && child.direction === node.direction) {
      sized ||= child.sizes !== undefined;
      splitShares(child).forEach((share, at) => kept.push({ child: child.children[at]!, share: share * shares[index]! }));
    } else {
      kept.push({ child, share: shares[index]! });
    }
  });
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0]!.child;
  return split(node.direction, kept.map((entry) => entry.child), sized ? normalized(kept.map((entry) => entry.share)) : undefined);
}

/** The split at `path` (child indexes from the root), if there is one. */
export function splitAtPath(node: PaneNode, path: readonly number[]): Extract<PaneNode, { kind: "split" }> | undefined {
  let current: PaneNode | undefined = node;
  for (const index of path) current = current?.kind === "split" ? current.children[index] : undefined;
  return current?.kind === "split" ? current : undefined;
}

/**
 * New shares for the split at `path`: clamped so no pane falls under
 * `MIN_PANE_SHARE`, and normalized. Shares that do not fit the split leave
 * the tree alone.
 */
export function resizeSplit(node: PaneNode, path: readonly number[], sizes: readonly number[]): PaneNode {
  if (path.length === 0) {
    if (node.kind !== "split" || sizes.length !== node.children.length || !sizes.every((size) => Number.isFinite(size) && size > 0)) return node;
    return { ...node, sizes: normalized(normalized(sizes).map((size) => Math.max(size, MIN_PANE_SHARE))) };
  }
  if (node.kind !== "split") return node;
  const [index, ...rest] = path;
  const child = node.children[index!];
  const resized = child ? resizeSplit(child, rest, sizes) : child;
  return resized === child ? node : { ...node, children: node.children.map((entry, at) => at === index ? resized! : entry) };
}

/**
 * Moves the divider before child `index` of a split by `delta` of its length:
 * only the two panes beside it change, and neither shrinks under the minimum.
 */
export function moveDivider(shares: readonly number[], index: number, delta: number): number[] {
  if (index <= 0 || index >= shares.length) return [...shares];
  const before = shares[index - 1]!;
  const after = shares[index]!;
  const pair = before + after;
  const min = Math.min(MIN_PANE_SHARE, pair / 2);
  const next = Math.min(pair - min, Math.max(min, before + delta));
  const result = [...shares];
  result[index - 1] = next;
  result[index] = pair - next;
  return result;
}

/** The pane `step` places after `id` in reading order, wrapping around. */
export function nextPane(node: PaneNode, id: string, step: 1 | -1 = 1): string {
  const ids = paneIds(node);
  const index = ids.indexOf(id);
  if (index === -1) return ids[0] ?? id;
  return ids[(index + step + ids.length) % ids.length]!;
}

/** The group, panel tab or stage tab, that draws a shell. */
export function groupOf(layout: TerminalLayout, id: string): TerminalGroup | undefined {
  return layout.groups.find((group) => hasPane(group.root, id)) ?? layout.stage.find((group) => hasPane(group.root, id));
}

/** Whether a shell is drawn in a stage tab. */
export function isStaged(layout: TerminalLayout, id: string): boolean {
  return layout.stage.some((group) => hasPane(group.root, id));
}

export function stageGroup(layout: TerminalLayout, groupId: string): TerminalGroup | undefined {
  return layout.stage.find((group) => group.id === groupId);
}

/** `base`, or `base` with a number after it when a tab already has that id. */
function freeGroupId(layout: TerminalLayout, base: string): string {
  const taken = new Set([...layout.groups, ...layout.stage].map((group) => group.id));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/** The groups replaced; `active` stays if it still names a tab, else the last tab is. */
function withGroups(layout: TerminalLayout, groups: TerminalGroup[], active = layout.active): TerminalLayout {
  const kept = active && groups.some((group) => group.id === active) ? active : groups.at(-1)?.id;
  const { active: _previous, ...rest } = layout;
  return kept ? { ...rest, groups, active: kept } : { ...rest, groups };
}

/** One group changed, wherever it is. */
function withGroup(layout: TerminalLayout, next: TerminalGroup): TerminalLayout {
  const swap = (groups: TerminalGroup[]) => groups.map((entry) => entry.id === next.id ? next : entry);
  return { ...layout, groups: swap(layout.groups), stage: swap(layout.stage) };
}

/** A group without `id`: the pane beside it takes the focus, an emptied group is `undefined`. */
function withoutPane(group: TerminalGroup, id: string): TerminalGroup | undefined {
  const root = removePane(group.root, id);
  if (!root) return undefined;
  const ids = paneIds(group.root);
  const at = ids.indexOf(id);
  const focused = group.focused === id ? ids[at - 1] ?? ids[at + 1]! : group.focused;
  return { ...group, root, focused: hasPane(root, focused) ? focused : paneIds(root)[0]! };
}

/**
 * Takes a shell out of whichever tab holds it. An emptied panel tab goes and
 * the tab beside it becomes active; an emptied stage group goes, and its tab
 * closes itself.
 */
export function detachPane(layout: TerminalLayout, id: string): TerminalLayout {
  const staged = layout.stage.find((group) => hasPane(group.root, id));
  if (staged) {
    const next = withoutPane(staged, id);
    return { ...layout, stage: next ? layout.stage.map((entry) => entry.id === staged.id ? next : entry) : layout.stage.filter((entry) => entry.id !== staged.id) };
  }
  const index = layout.groups.findIndex((group) => hasPane(group.root, id));
  if (index === -1) return layout;
  const group = layout.groups[index]!;
  const next = withoutPane(group, id);
  if (!next) {
    const groups = layout.groups.filter((entry) => entry.id !== group.id);
    const neighbour = groups[Math.min(index, groups.length - 1)];
    return withGroups(layout, groups, layout.active === group.id ? neighbour?.id : layout.active);
  }
  return withGroup(layout, next);
}

/** A shell in a panel tab of its own, made active. */
export function addGroup(layout: TerminalLayout, id: string, groupId = `group-${id}`): TerminalLayout {
  const detached = detachPane(layout, id);
  const free = freeGroupId(detached, groupId);
  return { ...detached, groups: [...detached.groups, { id: free, root: pane(id), focused: id }], active: free };
}

/** A new shell beside `target`, focused, in the target's tab; without a target it gets a panel tab of its own. */
export function splitAt(layout: TerminalLayout, target: string | undefined, id: string, direction: SplitDirection): TerminalLayout {
  const detached = detachPane(layout, id);
  const group = target ? groupOf(detached, target) : undefined;
  if (!group || !target) return addGroup(detached, id);
  const next = withGroup(detached, { ...group, root: splitPane(group.root, target, id, direction), focused: id });
  return isStaged(next, id) ? next : { ...next, active: group.id };
}

/** A restarted shell takes its predecessor's place, in the panel or on the stage. */
export function replacePane(layout: TerminalLayout, from: string, to: string): TerminalLayout {
  const swap = (node: PaneNode): PaneNode => node.kind === "pane"
    ? node.id === from ? pane(to) : node
    : { ...node, children: node.children.map(swap) };
  const inGroups = (groups: TerminalGroup[]) => groups.map((group) => hasPane(group.root, from)
    ? { ...group, root: swap(group.root), focused: group.focused === from ? to : group.focused }
    : group);
  return { ...layout, groups: inGroups(layout.groups), stage: inGroups(layout.stage) };
}

/** The pane that has the keyboard; a panel pane's tab becomes the active one. */
export function focusPane(layout: TerminalLayout, id: string): TerminalLayout {
  const group = groupOf(layout, id);
  if (!group) return layout;
  const staged = isStaged(layout, id);
  if (group.focused === id && (staged || layout.active === group.id)) return layout;
  const next = withGroup(layout, { ...group, focused: id });
  return staged ? next : { ...next, active: group.id };
}

/** The focused pane of the panel's active tab, if the panel shows any. */
export function focusedPane(layout: TerminalLayout): string | undefined {
  return layout.groups.find((group) => group.id === layout.active)?.focused;
}

/** Focus moves through the panes of one tab, wrapping around: the one holding `from`, else the panel's active one. */
export function focusNext(layout: TerminalLayout, step: 1 | -1 = 1, from?: string): TerminalLayout {
  const group = (from ? groupOf(layout, from) : undefined) ?? layout.groups.find((entry) => entry.id === layout.active);
  if (!group) return layout;
  return focusPane(layout, nextPane(group.root, group.focused, step));
}

/**
 * The shell leaves the panel for a stage tab of its own; it keeps running in
 * the host. The stage group is named `groupId`, the shell's id by default,
 * which is what its tab is opened with.
 */
export function moveToStage(layout: TerminalLayout, id: string, groupId = id): TerminalLayout {
  if (isStaged(layout, id)) return layout;
  const detached = detachPane(layout, id);
  return { ...detached, stage: [...detached.stage, { id: freeGroupId(detached, groupId), root: pane(id), focused: id }] };
}

/** A stage tab came back from storage: its group stays, or the shell its id names is staged again. */
export function restoreStageGroup(layout: TerminalLayout, groupId: string): TerminalLayout {
  return stageGroup(layout, groupId) ? layout : moveToStage(layout, groupId);
}

/** Its stage tab closed: the group's shells come back to the panel as one tab, in the tree they had. */
export function returnFromStage(layout: TerminalLayout, groupId: string): TerminalLayout {
  const group = stageGroup(layout, groupId);
  if (!group) return layout;
  const rest = { ...layout, stage: layout.stage.filter((entry) => entry.id !== groupId) };
  const id = freeGroupId(rest, `group-${paneIds(group.root)[0]}`);
  return { ...rest, groups: [...rest.groups, { ...group, id }], active: id };
}

/** Resizes a split of one tab; see `resizeSplit`. */
export function resizeGroupSplit(layout: TerminalLayout, groupId: string, path: readonly number[], sizes: readonly number[]): TerminalLayout {
  const group = [...layout.groups, ...layout.stage].find((entry) => entry.id === groupId);
  if (!group) return layout;
  const root = resizeSplit(group.root, path, sizes);
  return root === group.root ? layout : withGroup(layout, { ...group, root });
}

/**
 * Brings a layout in line with the shells the host holds: panes of shells
 * that are gone leave, and a shell no tab and no stage tab draws gets a tab
 * of its own — unless it is `held`, one a split is about to place.
 */
export function reconcileLayout(layout: TerminalLayout, sessions: readonly string[], held: ReadonlySet<string> = new Set()): TerminalLayout {
  const live = new Set(sessions);
  let next = layout;
  for (const group of [...layout.groups, ...layout.stage]) {
    for (const id of paneIds(group.root)) if (!live.has(id)) next = detachPane(next, id);
  }
  const placed = new Set([...next.groups, ...next.stage].flatMap((group) => paneIds(group.root)));
  for (const id of sessions) {
    if (!placed.has(id) && !held.has(id)) next = addGroup(next, id);
  }
  return next;
}

/**
 * A layout read back from storage, or the empty one when it does not parse.
 * A layout from before stage tabs held splits names its staged shells in
 * `onStage`; each becomes a stage group of one.
 */
export function parseLayout(value: unknown): TerminalLayout {
  const raw = value as (Partial<TerminalLayout> & { onStage?: unknown }) | null;
  if (!raw || !Array.isArray(raw.groups)) return EMPTY_LAYOUT;
  const groups = parseGroups(raw.groups);
  const stage = Array.isArray(raw.stage)
    ? parseGroups(raw.stage)
    : Array.isArray(raw.onStage)
      ? raw.onStage.filter((id): id is string => typeof id === "string").map((id) => ({ id, root: pane(id), focused: id }))
      : undefined;
  if (!stage) return EMPTY_LAYOUT;
  return withGroups({ groups: [], stage }, groups, typeof raw.active === "string" ? raw.active : undefined);
}

function parseGroups(value: unknown[]): TerminalGroup[] {
  return value.flatMap((entry) => {
    const group = entry as Partial<TerminalGroup> | null;
    if (!group || typeof group.id !== "string" || typeof group.focused !== "string") return [];
    const root = parseNode(group.root);
    return root ? [{ id: group.id, root, focused: group.focused }] : [];
  });
}

function parseNode(value: unknown): PaneNode | undefined {
  const node = value as { kind?: unknown; id?: unknown; direction?: unknown; children?: unknown; sizes?: unknown } | null;
  if (node?.kind === "pane") return typeof node.id === "string" ? pane(node.id) : undefined;
  if (node?.kind !== "split" || (node.direction !== "right" && node.direction !== "down") || !Array.isArray(node.children) || node.children.length === 0) return undefined;
  const children = node.children.map(parseNode);
  if (!children.every((child): child is PaneNode => child !== undefined)) return undefined;
  // Shares that do not fit the children are dropped, not the whole tree.
  const sizes = Array.isArray(node.sizes) && node.sizes.length === children.length && node.sizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0)
    ? normalized(node.sizes as number[])
    : undefined;
  return split(node.direction, children, sizes);
}
