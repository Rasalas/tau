import type { ThreadIndexSnapshot, UiThreadUsage } from "./contracts.js";
import type { PairingEndpoint, UiHostEndpointKind } from "./connections.js";

/**
 * The machines one window knows (ADR 0025): its own, whose host it runs, and
 * the ones the user paired with. The window's process owns the list; a page
 * reads it through the client-side `environments-*` methods and the
 * `environments` window event.
 */

/** How the window's own connection to a machine is doing. */
export type EnvironmentStatus = "connecting" | "connected" | "offline" | "refused";

/** One thread of a machine, as its list shows it. */
export interface UiEnvironmentThread {
  id: string;
  /** What `switch-session` takes on that machine. */
  path: string;
  title: string;
  projectName: string;
  workspaceId?: string;
  modifiedAt: number;
  running?: boolean;
}

export interface UiEnvironmentProject {
  workspaceId?: string;
  name: string;
  lastOpenedAt: number;
}

export interface UiEnvironment {
  /** The machine's host id; stable across addresses and restarts. */
  id: string;
  name: string;
  /** The window's own machine: always listed, never removed. */
  local: boolean;
  status: EnvironmentStatus;
  /** Why it is refused or offline, written for the user. */
  detail?: string;
  roundTripMs?: number;
  /** When the window last heard from it; for an offline machine. */
  lastSeenAt?: number;
  /** The address the connection uses or last used. */
  address?: string;
  /** Set when the machine paired this window Read only. */
  readOnly?: boolean;
  hostVersion?: string;
  /** Newest first, capped; kept from the last connection while offline. */
  threads: UiEnvironmentThread[];
  /** How many threads the machine has in all. */
  threadCount: number;
  projects: UiEnvironmentProject[];
}

/** A pairing the window is waiting on; one at a time. */
export interface UiEnvironmentPairing {
  address: string;
  state: "connecting" | "waiting" | "failed";
  /** The six digits both screens show while the owner decides. */
  verification?: string;
  expiresAt?: string;
  message?: string;
}

export interface UiEnvironments {
  /** The machine the page was loaded for. */
  shown: string;
  environments: UiEnvironment[];
  pairing?: UiEnvironmentPairing;
  /** False where the window's process cannot keep a token encrypted; adding a machine then fails. */
  secureStorage: boolean;
  /** The window shows the machine it showed last again after a restart, when that one answers in time. */
  reopenShown?: boolean;
}

/** The window's own choices about its machines. */
export interface EnvironmentPreferences {
  reopenShown?: boolean;
}

/** What to show once the page arrives on a machine. */
export type EnvironmentTarget =
  | { thread: { path: string } }
  | { newThread: EnvironmentNewThread };

export interface EnvironmentNewThread {
  draft?: string;
  workspaceId?: string;
  /** Sends `draft` as the thread's first prompt once it is placed (API 1.15.0). */
  send?: boolean;
  /** The model the draft had here, picked there before it is sent (API 1.15.0). */
  model?: { provider: string; id: string };
}

/**
 * What `open` takes besides an arrival: a thread named by its id on that
 * machine, which the window finds in the machine's index (API 1.15.0).
 */
export type EnvironmentOpenTarget = EnvironmentTarget | { threadId: string };

/**
 * A thread of another machine as a look-in tab follows it (API 1.15.0): what
 * the window's own connection to that machine knows of it. The transcript
 * itself is read with `transcriptPage`, again whenever `revision` grows.
 */
export interface UiEnvironmentThreadView {
  machine: string;
  sessionId: string;
  /** The machine's name, or the id the tab was opened with when the window does not know it. */
  machineName: string;
  /** How the window's connection to the machine is doing; `unknown` for a machine it does not know. */
  status: EnvironmentStatus | "unknown";
  /** Why it is offline or refused, written for the user. */
  detail?: string;
  /** Since when the machine is unreachable, when it was reached before. */
  lastSeenAt?: number;
  /** The thread as that machine's index lists it; absent before the index arrived, or once it is gone there. */
  thread?: {
    title: string;
    /** What `open(machine, { thread: { path } })` takes. */
    path: string;
    projectName: string;
    modifiedAt: number;
    messageCount: number;
    running: boolean;
    usage?: UiThreadUsage;
    parentThreadId?: string;
  };
  /** False until the machine's index arrived: before that, a missing `thread` says nothing. */
  indexed: boolean;
  /** The dialog the thread waits on there, when the window saw it asked. */
  asking?: { id: string; title: string };
  /** Grows with every change of the thread there; a reader loads the transcript again. */
  revision: number;
}

/** The window event that carries a look-in tab's thread; the host never sends it. */
export const ENVIRONMENT_THREAD_EVENT = "environment-thread";

/**
 * A pairing link (or a QR code's text), a bare address the owner is asked
 * from, or the host id of a machine the window's last Bonjour search found.
 */
export interface EnvironmentPairInput {
  text?: string;
  /** Pairs with the found machine's addresses and pins the fingerprint its record carried. */
  nearby?: string;
  /** How this window names itself to the owner; the machine's name by default. */
  deviceName?: string;
  /**
   * Also asks for this computer's agents, as a second device under the same
   * approval, and hands their key to this computer's host (ADR 0027). On
   * unless false; a window without a host of its own asks for none.
   */
  agents?: boolean;
}

/** Whether this computer's agents got a key of their own for the machine; absent when none was asked for. */
export type EnvironmentAgentsOutcome = { added: true } | { added: false; message: string };

export type EnvironmentPairResult =
  | { state: "added"; environment: UiEnvironment; agents?: EnvironmentAgentsOutcome }
  | { state: "denied" | "expired" | "cancelled" }
  | { state: "failed"; message: string };

/** What turning this computer's agents on or off for a machine came to. */
export type EnvironmentAgentsResult =
  | { state: "on" | "off" }
  | { state: "denied" | "expired" | "cancelled" }
  | { state: "failed"; message: string };

/** The name the agents' device goes by on the other machine. */
export function agentsDeviceName(deviceName: string): string {
  return `${deviceName.slice(0, 60 - " · Agents".length).trim()} · Agents`;
}

/** The window event that carries the list; the host never sends it. */
export const ENVIRONMENTS_EVENT = "environments";

export const ENVIRONMENT_THREAD_LIMIT = 40;

/** Addresses in the order a connection tries them: the one that worked last, then the nearest. */
export function orderEndpoints(endpoints: readonly PairingEndpoint[], lastUrl?: string): PairingEndpoint[] {
  const rank: Record<UiHostEndpointKind, number> = { loopback: 0, lan: 1, mdns: 2, tailscale: 3, magicdns: 4 };
  const sorted = endpoints
    .map((endpoint, index) => ({ endpoint, index }))
    .sort((a, b) => (rank[a.endpoint.kind ?? "lan"] - rank[b.endpoint.kind ?? "lan"]) || a.index - b.index)
    .map((entry) => entry.endpoint);
  const last = lastUrl ? sorted.find((endpoint) => endpoint.url === lastUrl) : undefined;
  return last ? [last, ...sorted.filter((endpoint) => endpoint !== last)] : sorted;
}

const MAX_ENDPOINTS = 16;

/**
 * A saved machine's addresses after it told fresh ones (its hello, or a
 * Bonjour record). LAN addresses follow the machine; names, Tailscale
 * addresses and what the user typed stay until it is paired again, since a
 * machine reached one way may not list the others right now. `keep` is an
 * address that just worked.
 */
export function refreshEndpoints(saved: readonly PairingEndpoint[], fresh: readonly PairingEndpoint[], keep?: string): PairingEndpoint[] {
  if (fresh.length === 0) return [...saved];
  const urls = new Set(fresh.map((endpoint) => endpoint.url));
  const kept = saved.filter((endpoint) => !urls.has(endpoint.url) && (endpoint.kind !== "lan" || endpoint.url === keep));
  const seen = new Set<string>();
  return [...fresh, ...kept]
    .filter((endpoint) => /^https?:\/\//u.test(endpoint.url) && !seen.has(endpoint.url) && seen.add(endpoint.url))
    .slice(0, MAX_ENDPOINTS)
    .map((endpoint) => ({ url: endpoint.url, ...(endpoint.kind ? { kind: endpoint.kind } : {}), ...(endpoint.trustedCertificate ? { trustedCertificate: true } : {}) }));
}

/** Whether two address lists name the same addresses in the same order. */
export function sameEndpoints(a: readonly PairingEndpoint[], b: readonly PairingEndpoint[]): boolean {
  return a.length === b.length && a.every((endpoint, index) => endpoint.url === b[index]!.url && endpoint.kind === b[index]!.kind
    && Boolean(endpoint.trustedCertificate) === Boolean(b[index]!.trustedCertificate));
}

/** `https://host:7788/` → `wss://host:7788/`; the socket lives on the page's own origin. */
export function socketUrl(pageUrl: string): string {
  const url = new URL(pageUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  url.hash = "";
  url.search = "";
  return url.toString();
}

/** A page URL from what a user typed: `host`, `host:port`, or a URL of any of the four schemes. */
export function addressPageUrl(text: string, defaultPort = 7788): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || /\s/u.test(trimmed)) return undefined;
  const withScheme = /^[a-z]+:\/\//iu.test(trimmed) ? trimmed.replace(/^ws/iu, "http") : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (!url.hostname) return undefined;
    if (!url.port && !/^[a-z]+:\/\/[^/]*:\d+/iu.test(withScheme)) url.port = String(defaultPort);
    return `${url.protocol}//${url.host}/`;
  } catch {
    return undefined;
  }
}

/** The list a machine's row shows: the user's own threads, newest first, capped, the running ones marked. */
export function environmentThreads(index: ThreadIndexSnapshot, running: ReadonlySet<string>, limit = ENVIRONMENT_THREAD_LIMIT): UiEnvironmentThread[] {
  // A spawned agent's thread shows under its parent on that machine, not here.
  return index.sessions.filter((session) => !session.parentThreadId)
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, limit)
    .map((session) => {
      const thread: UiEnvironmentThread = {
        id: session.id,
        path: session.path,
        title: session.title || "Untitled thread",
        projectName: session.projectName,
        modifiedAt: session.modifiedAt,
      };
      if (session.workspaceId) thread.workspaceId = session.workspaceId;
      if (running.has(session.id)) thread.running = true;
      return thread;
    });
}

export function environmentProjects(index: ThreadIndexSnapshot): UiEnvironmentProject[] {
  return [...index.projects]
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .map((project) => {
      const entry: UiEnvironmentProject = { name: project.name, lastOpenedAt: project.lastOpenedAt };
      if (project.workspaceId) entry.workspaceId = project.workspaceId;
      return entry;
    });
}

/**
 * Client storage keys that hold one host's state. A page showing another
 * machine keeps them apart by suffixing that machine's id; everything else
 * (preferences, layout, keybindings) is the window's and stays shared.
 */
export function environmentStorageKey(key: string, environment: string | undefined, hostKeys: readonly string[]): string {
  if (!environment) return key;
  return hostKeys.some((hostKey) => key === hostKey || key.startsWith(`${hostKey}:`)) ? `${key}@${environment}` : key;
}

/** `open`'s target: an arrival, or a thread named by its id there. */
export function decodeEnvironmentOpenTarget(value: unknown): EnvironmentOpenTarget | undefined {
  const threadId = (value as { threadId?: unknown } | null | undefined)?.threadId;
  if (typeof threadId === "string" && threadId && threadId.length <= 512) return { threadId };
  return decodeEnvironmentTarget(value);
}

export function decodeEnvironmentTarget(value: unknown): EnvironmentTarget | undefined {
  if (!value || typeof value !== "object") return undefined;
  const thread = (value as { thread?: { path?: unknown } }).thread;
  if (thread && typeof thread.path === "string" && thread.path) return { thread: { path: thread.path } };
  const draft = (value as { newThread?: { draft?: unknown; workspaceId?: unknown; send?: unknown; model?: { provider?: unknown; id?: unknown } } }).newThread;
  if (draft && typeof draft === "object") {
    const model = draft.model && typeof draft.model === "object" && typeof draft.model.provider === "string" && typeof draft.model.id === "string"
      ? { provider: draft.model.provider.slice(0, 200), id: draft.model.id.slice(0, 200) }
      : undefined;
    return {
      newThread: {
        ...(typeof draft.draft === "string" ? { draft: draft.draft.slice(0, 100_000) } : {}),
        ...(typeof draft.workspaceId === "string" ? { workspaceId: draft.workspaceId } : {}),
        ...(draft.send === true && typeof draft.draft === "string" && draft.draft.trim() ? { send: true } : {}),
        ...(model ? { model } : {}),
      },
    };
  }
  return undefined;
}
