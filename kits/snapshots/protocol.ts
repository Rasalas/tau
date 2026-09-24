export const SNAPSHOTS_EXTENSION_ID = "tau.snapshots";

/** The accessibility client the window half loads through `loadDependency`. */
export const ACCESSIBILITY_PACKAGE = "@crowecawcaw/xa11y";

/** Emitted with a `SnapShotMeta` when a capture is stored and waits for a composer. */
export const SNAPSHOT_EVENT = "snapshot";

/** Emitted with `{ message }` when the shortcut fired and nothing could be captured. */
export const SNAPSHOT_FAILED_EVENT = "snapshot-failed";

/** Emitted with a `ShortcutState` when the window registered or dropped the shortcut. */
export const SHORTCUT_EVENT = "shortcut";

/** Off-the-shelf enough to remember, clear of macOS's own ⇧⌘3/4/5. */
export const DEFAULT_SHORTCUT = "CommandOrControl+Shift+2";

/** Settings, as `options.tau.snapshots.<name>` and `values.tau.snapshots.<name>`. */
export const SETTING_ENABLED = "shortcut-enabled";
export const SETTING_SHORTCUT = "shortcut";
export const SETTING_ACCESSIBILITY = "accessibility";

/** T3 Code's bounds for what one capture may carry to the model. */
export const MAX_ACCESSIBILITY_NODES = 10_000;
export const MAX_ACCESSIBILITY_CHARS = 32_000;
export const MAX_TEXT_CHARS = 32_000;

export interface SnapShotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapShotElementState {
  checked?: "on" | "off" | "mixed";
  disabled?: true;
  editable?: true;
  expanded?: boolean;
  focused?: true;
  selected?: true;
}

/** One element of the window, bounds in the pixels of the captured image. */
export interface SnapShotElement {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  bounds?: SnapShotBounds;
  state?: SnapShotElementState;
  actions?: string[];
  children: SnapShotElement[];
}

export interface SnapShotAccessibility {
  /** The size of the image `bounds` are measured in. */
  imageSize: { width: number; height: number };
  /** Some elements were left out: too many, too long, or too slow to read. */
  truncated: boolean;
  nodes: number;
  root: SnapShotElement;
}

/** The window a capture shows. `windowId` is the system's own number for it. */
export interface SnapShotTarget {
  windowId: number;
  pid: number;
}

/** What the window half answers for one capture. */
export interface SnapShotCapture {
  app: string;
  title: string;
  pid: number;
  capturedAt: number;
  image: { data: string; mimeType: string; width: number; height: number };
  accessibility?: SnapShotAccessibility;
  /** Why there is no accessibility data, when it was asked for. */
  accessibilityNote?: string;
}

/** A stored capture as a client lists it; the picture and the tree are read separately. */
export interface SnapShotMeta {
  id: string;
  app: string;
  title: string;
  capturedAt: number;
  width: number;
  height: number;
  mimeType: string;
  size: number;
  accessibility?: { nodes: number; truncated: boolean };
  accessibilityNote?: string;
  /** A client already put it into a composer. */
  claimed: boolean;
}

export interface SnapShotContent {
  meta: SnapShotMeta;
  /** Base64. */
  data: string;
  accessibility?: SnapShotAccessibility;
}

export type Permission = "granted" | "denied" | "not-determined" | "restricted" | "unavailable";

/** What this machine lets Tau do; `platform` other than macOS means SnapShots are off here. */
export interface SnapShotAccess {
  supported: boolean;
  screen: Permission;
  accessibility: Permission;
}

export type PermissionKind = "screen" | "accessibility";

export interface ShortcutState {
  /** The accelerator that is registered now, if any. */
  registered?: string;
  error?: string;
}

export interface ArmInput {
  /** `null` drops the shortcut. */
  accelerator: string | null;
  accessibility: boolean;
}

export interface SnapShotsHostCommands {
  /** Captures `target`, or the window in front when none is named. */
  "capture": { input: { target?: SnapShotTarget; accessibility?: boolean }; output: SnapShotMeta };
  "pending": { input: undefined; output: SnapShotMeta[] };
  /** Marks a capture as taken by a composer; `null` when another client was first or it is gone. */
  "claim": { input: { id: string }; output: SnapShotMeta | null };
  "meta": { input: { ids: string[] }; output: (SnapShotMeta | null)[] };
  "read": { input: { id: string }; output: SnapShotContent | null };
  /** Deletes captures that were sent or removed. */
  "release": { input: { ids: string[] }; output: void };
  "arm": { input: ArmInput; output: ShortcutState };
  "shortcut-state": { input: undefined; output: ShortcutState };
  /** What `arm` set in the window a call reaches now; null when that window was not armed. */
  "armed": { input: undefined; output: ArmInput | null };
  "access": { input: undefined; output: SnapShotAccess };
  "request-access": { input: { kind: PermissionKind }; output: SnapShotAccess };
  "open-settings": { input: { kind: PermissionKind }; output: void };
}

/** What the host asks of the window half, and what the window tells its host half. */
export interface SnapShotsWindowCommands {
  "access": { input: undefined; output: SnapShotAccess };
  "request-access": { input: { kind: PermissionKind }; output: SnapShotAccess };
  "open-settings": { input: { kind: PermissionKind }; output: void };
  "shortcut": { input: ArmInput; output: ShortcutState };
  "capture": { input: { target?: SnapShotTarget; accessibility: boolean }; output: SnapShotCapture };
}

/** The window half's own call into the host when the shortcut fired: `{ capture }` or `{ error }`. */
export const CAPTURED_COMMAND = "captured";
