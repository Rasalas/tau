export const CUSTOMIZE_EXTENSION_ID = "tau.customize";

export const CUSTOMIZE_COMMANDS = {
  get: "get",
  set: "set",
  openScript: "open-script",
  release: "release",
} as const;

/** Pushed to every client after a write, with the whole state. */
export const CUSTOMIZE_CHANGED_EVENT = "changed";

/** CSS a client mounts after every extension's own sheet. */
export interface UserStyle {
  id: string;
  name: string;
  css: string;
  enabled: boolean;
}

/** Where a user script draws: in a part's place, or as a part of its own at a placement. */
export type UserScriptTarget =
  | { replace: string }
  | { placement: string; order?: number };

/** A document the host serves on the sandbox frame, with Tau's tokens and the `tau` bridge. */
export interface UserScript {
  id: string;
  name: string;
  enabled: boolean;
  target: UserScriptTarget;
  html: string;
  /** The tallest the frame grows, in px. */
  maxHeight?: number;
  /** Raised on every edit, so a client reloads the frame. */
  revision: number;
}

/** What the host keeps in `customizations.json`, one per machine. */
export interface CustomizeState {
  version: 1;
  hidden: string[];
  order: Record<string, number>;
  placement: Record<string, string>;
  styles: UserStyle[];
  scripts: UserScript[];
}

export const EMPTY_STATE: CustomizeState = { version: 1, hidden: [], order: {}, placement: {}, styles: [], scripts: [] };

export const CUSTOMIZE_LIMITS = {
  names: 500,
  nameLength: 200,
  styles: 50,
  styleBytes: 256 * 1024,
  scripts: 50,
  scriptBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
} as const;

export type ScriptOpen =
  | { state: "ready"; path: string; maxHeight: number }
  | { state: "missing" };

/**
 * A value a kit lends to user scripts, provided as a service: a script reads it
 * with `tau.data(id, callback)`. Only a service with `shared: true` is readable;
 * the snapshot must be plain data.
 */
export interface SharedData<T = unknown> {
  shared: true;
  getSnapshot(): T;
  subscribe(listener: () => void): () => void;
}

/** Messages between a script's frame and its client, JSON-RPC 2.0 over postMessage. */
export const SCRIPT_MESSAGES = {
  size: "ui/notifications/size-changed",
  width: "tau/width",
  link: "ui/open-link",
  subscribe: "tau/data/subscribe",
  unsubscribe: "tau/data/unsubscribe",
  data: "tau/data",
  openPage: "tau/open-page",
  runCommand: "tau/run-command",
} as const;
