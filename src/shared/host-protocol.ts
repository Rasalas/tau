import type {
  HostSnapshot,
  ThreadIndexSnapshot,
  UiContextUsage,
  UiMessage,
  UiModel,
  UiToolRun,
  UiWorkspaceChanges,
} from "./contracts.js";

/** The wire version is deliberately independent from the Pi SDK version. */
export const HOST_PROTOCOL_VERSION = 1 as const;
export type HostProtocolVersion = typeof HOST_PROTOCOL_VERSION;

export interface ThreadShellUpdate {
  sessionId: string;
  shell?: ThreadIndexSnapshot["sessions"][number];
  removed?: boolean;
}

export interface ThreadIndexUpdate {
  projects: ThreadIndexSnapshot["projects"];
  sessions: ThreadIndexSnapshot["sessions"];
}

export interface ThreadDetail {
  sessionId: string;
  messages: UiMessage[];
  isStreaming: boolean;
  activeTools: string[];
  contextUsage?: UiContextUsage;
  /** Cursor for the next page of older transcript records. */
  olderCursor?: string;
}

export interface TranscriptPage {
  sessionId: string;
  messages: UiMessage[];
  olderCursor?: string;
  hasMore: boolean;
}

export interface HostCatalog {
  models: UiModel[];
  model?: UiModel;
  thinkingLevel: string;
  thinkingLevels: string[];
  allTools: Array<{ name: string; description: string }>;
  extensionCount: number;
}

export interface ProjectMetadata {
  cwd: string;
  branch?: string;
  changes?: UiWorkspaceChanges;
}

export type HostUpdate =
  | { version: HostProtocolVersion; type: "thread-index"; index: ThreadIndexUpdate }
  | { version: HostProtocolVersion; type: "thread-shell"; update: ThreadShellUpdate }
  | { version: HostProtocolVersion; type: "thread-detail"; detail: ThreadDetail }
  | { version: HostProtocolVersion; type: "transcript-page"; page: TranscriptPage }
  | { version: HostProtocolVersion; type: "catalog"; catalog: HostCatalog }
  | { version: HostProtocolVersion; type: "project"; project: ProjectMetadata }
  | { version: HostProtocolVersion; type: "run"; event: "started" | "settled" | "aborted"; sessionId: string }
  | { version: HostProtocolVersion; type: "error"; message: string };

export interface HostActionResult {
  version: HostProtocolVersion;
  updates: HostUpdate[];
}

/**
 * Bootstrap is shell-first: the active detail and project metadata are useful
 * before catalogs and the global index have finished loading. `host` is only a
 * bounded recovery field for pre-v1 clients and is never emitted by normal
 * actions.
 */
export interface GranularHostBootstrap {
  version: HostProtocolVersion;
  detail: ThreadDetail;
  catalog?: HostCatalog;
  project: ProjectMetadata;
  index?: ThreadIndexUpdate;
  host?: HostSnapshot;
}

export function isHostUpdate(value: unknown): value is HostUpdate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { version?: unknown; type?: unknown };
  return candidate.version === HOST_PROTOCOL_VERSION && typeof candidate.type === "string" && [
    "thread-index", "thread-shell", "thread-detail", "transcript-page", "catalog", "project", "run", "error",
  ].includes(candidate.type);
}

/** Unknown versions/types are ignored rather than interpreted as snapshots. */
export function decodeHostUpdates(value: unknown): HostUpdate[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isHostUpdate);
}

export function detailFromSnapshot(snapshot: HostSnapshot, limit = 40): ThreadDetail {
  const messages = snapshot.messages.length > limit ? snapshot.messages.slice(-limit) : snapshot.messages;
  return {
    sessionId: snapshot.sessionId,
    messages,
    isStreaming: snapshot.isStreaming,
    activeTools: [...snapshot.activeTools],
    contextUsage: snapshot.contextUsage,
    ...(snapshot.messages.length > messages.length ? { olderCursor: String(snapshot.messages.length - messages.length) } : {}),
  };
}

export function catalogFromSnapshot(snapshot: HostSnapshot): HostCatalog {
  return {
    models: [...snapshot.models],
    model: snapshot.model,
    thinkingLevel: snapshot.thinkingLevel,
    thinkingLevels: [...snapshot.thinkingLevels],
    allTools: [...snapshot.allTools],
    extensionCount: snapshot.extensionCount,
  };
}