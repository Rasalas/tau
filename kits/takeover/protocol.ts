import type { ComponentType } from "react";
import type { WorkbenchActions } from "tau";

/**
 * Takeover Kit's contract between its halves. Core knows none of it: it routes
 * the commands by extension id and the state event to every attached client.
 */

export const TAKEOVER_EXTENSION_ID = "tau.takeover";

/** Event with `{ takeovers: Takeover[] }` whenever one starts or ends, to every client. */
export const TAKEOVER_STATE_EVENT = "state";

export const REQUEST_TAKEOVER_TOOL = "request_takeover";

/** How long a request waits for the user; Codex gives Tau's tools 35 minutes. */
export const TAKEOVER_TIMEOUT_MS = 30 * 60_000;

/**
 * What the user takes over: the Preview's page, the window the thread's agent
 * drives with Computer Use, a page in the user's own browser, or nothing to
 * bring forward (a code on the user's phone, say).
 */
export type TakeoverTarget =
  | { kind: "preview"; url?: string }
  | { kind: "window" }
  | { kind: "browser"; url: string }
  | { kind: "settings"; page: string }
  | { kind: "none" };

export interface Takeover {
  id: string;
  threadId: string;
  /** The agent's words: what the user is asked to do. */
  reason: string;
  target: TakeoverTarget;
  since: number;
  /** For a notification and for switching to the thread from it. */
  title?: string;
  sessionFile?: string;
}

export interface TakeoverHostCommands {
  "state": { input: undefined; output: Takeover[] };
  /** The user is done; the agent goes on. */
  "done": { input: { id: string }; output: boolean };
  /** The user will not; the agent stops. */
  "cancel": { input: { id: string }; output: boolean };
}

/** Push Kit's `notify`, which this kit calls for "your turn"; copied rather than imported. */
export const PUSH_EXTENSION_ID = "tau.push";

/** The Evidence Kit's commands this kit calls, copied rather than imported (a kit never imports another kit). */
export const EVIDENCE_EXTENSION_ID = "tau.evidence";

/** Tools that act on or look at what the user now controls: every Computer Use tool and every Preview tool. */
export function isHeldTool(name: string): boolean {
  const bare = name.replace(/^mcp__.+?__/u, "");
  return bare.startsWith("computer_use_") || bare.startsWith("preview_");
}

/** The surface a finished tool call used, so a request without a target goes where the agent was. */
export function surfaceOf(name: string): "preview" | "window" | undefined {
  const bare = name.replace(/^mcp__.+?__/u, "");
  if (bare.startsWith("preview_")) return "preview";
  if (bare.startsWith("computer_use_")) return "window";
  return undefined;
}

/** An http(s) address, or nothing: the only kind a button may open. */
export function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function readTakeovers(payload: unknown): Takeover[] {
  const list = Array.isArray(payload) ? payload : (payload as { takeovers?: unknown } | undefined)?.takeovers;
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is Takeover => Boolean(entry) && typeof entry === "object"
    && typeof (entry as Takeover).id === "string" && typeof (entry as Takeover).threadId === "string"
    && typeof (entry as Takeover).reason === "string" && typeof (entry as Takeover).target?.kind === "string");
}

/** Preview Kit's desktop services, copied the same way: the part this kit uses. */
export const PREVIEW_BROWSER_SERVICE = "tau.preview/browser";
export const PREVIEW_PANEL = "preview";
export const PREVIEW_EXTENSION_ID = "tau.preview";

export interface PreviewBrowserService {
  open(url: string, actions: { openPanel(id: string): void }): Promise<void>;
  jump(target: { kind: "browser" } | { kind: "app"; threadId: string }, actions: { openPanel(id: string): void }): Promise<void>;
  /** A small live picture of the page or the driven window; returns the stop (API 1.13.0). */
  watch?(target: { kind: "browser" } | { kind: "app"; threadId: string }, maxWidth: number, onFrame: (picture: { url: string; width: number; height: number } | undefined) => void): () => void;
  /** This client is not on the host's machine: `jump` opens the Preview here, where the user drives it. */
  remote?(): boolean;
  /** The user holds the page: the amber frame, and on a phone `Bar` and `Footer` around it; returns the release. */
  hold?(control: { Bar?: ComponentType<{ actions: WorkbenchActions }>; Footer?: ComponentType }): () => void;
}

export const PREVIEW_COOKIE_IMPORT_SERVICE = "tau.preview/cookie-import";

export interface CookieImportResult {
  imported: number;
  skipped: number;
  skippedSites: string[];
  profile: string;
  reloaded: boolean;
}

export interface PreviewCookieImportService {
  importSite(request: { site: string; profile?: string }): Promise<CookieImportResult | undefined>;
}

/** Computer Use's screen service, the part this kit reads: which app a thread drives, and raising it. */
export const COMPUTER_USE_SCREEN_SERVICE = "tau.computer-use/screen";

export interface ComputerUseScreenService {
  load(threadId: string): Promise<{ window?: { app?: string; title?: string } } | undefined>;
  bringToFront(threadId: string): Promise<void>;
  /** The driven app's icon as a data URL, where the host's window can draw one. */
  icon?(threadId: string): Promise<string | null>;
}

