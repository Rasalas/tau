import type {
  HostSnapshot,
  ServiceTier,
  ThreadIndexSnapshot,
  UiComposerCommand,
  UiContextUsage,
  UiMessage,
  UiModel,
  UiTaskProgress,
  UiTaskProgressEntry,
  UiToolRun,
  UiTurnActivity,
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
  turnActivity?: UiTurnActivity;
  taskProgress?: UiTaskProgress;
  taskHistory?: UiTaskProgressEntry[];
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
  sessionId: string;
  models: UiModel[];
  model?: UiModel;
  thinkingLevel: string;
  thinkingLevels: string[];
  serviceTier: ServiceTier;
  serviceTierAvailable: boolean;
  allTools: Array<{ name: string; description: string }>;
  composerCommands?: UiComposerCommand[];
  extensionCount: number;
  supportsImageInput: boolean;
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

/** Bootstrap is shell-first; no legacy full snapshot crosses IPC. */
export interface GranularHostBootstrap {
  version: HostProtocolVersion;
  detail: ThreadDetail;
  catalog: HostCatalog;
  project: ProjectMetadata;
  index?: ThreadIndexUpdate;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function isHostUpdate(value: unknown): value is HostUpdate {
  const candidate = record(value);
  if (!candidate || candidate.version !== HOST_PROTOCOL_VERSION || typeof candidate.type !== "string") return false;
  const payload = record(candidate[
    candidate.type === "thread-index" ? "index" :
      candidate.type === "thread-shell" ? "update" :
        candidate.type === "thread-detail" ? "detail" :
          candidate.type === "transcript-page" ? "page" :
            candidate.type === "catalog" ? "catalog" :
              candidate.type === "project" ? "project" : ""
  ]);
  switch (candidate.type) {
    case "thread-index": return Boolean(payload && Array.isArray(payload.projects) && Array.isArray(payload.sessions));
    case "thread-shell": return Boolean(payload && typeof payload.sessionId === "string" && (payload.shell === undefined || record(payload.shell)));
    case "thread-detail": return Boolean(payload && typeof payload.sessionId === "string" && Array.isArray(payload.messages) && typeof payload.isStreaming === "boolean" && Array.isArray(payload.activeTools));
    case "transcript-page": return Boolean(payload && typeof payload.sessionId === "string" && Array.isArray(payload.messages) && typeof payload.hasMore === "boolean");
    case "catalog": return Boolean(payload && typeof payload.sessionId === "string" && Array.isArray(payload.models) && typeof payload.thinkingLevel === "string" && Array.isArray(payload.thinkingLevels) && Array.isArray(payload.allTools) && typeof payload.extensionCount === "number" && typeof payload.supportsImageInput === "boolean");
    case "project": return Boolean(payload && typeof payload.cwd === "string");
    case "run": return typeof candidate.sessionId === "string" && ["started", "settled", "aborted"].includes(String(candidate.event));
    case "error": return typeof candidate.message === "string";
    default: return false;
  }
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
    turnActivity: snapshot.turnActivity,
    taskProgress: snapshot.taskProgress,
    taskHistory: snapshot.taskHistory,
    contextUsage: snapshot.contextUsage,
    ...(snapshot.messages.length > messages.length ? { olderCursor: String(snapshot.messages.length - messages.length) } : {}),
  };
}

export function catalogFromSnapshot(snapshot: HostSnapshot): HostCatalog {
  return {
    sessionId: snapshot.sessionId,
    models: [...snapshot.models],
    model: snapshot.model,
    thinkingLevel: snapshot.thinkingLevel,
    thinkingLevels: [...snapshot.thinkingLevels],
    serviceTier: snapshot.serviceTier,
    serviceTierAvailable: snapshot.serviceTierAvailable,
    allTools: [...snapshot.allTools],
    composerCommands: snapshot.composerCommands?.map((command) => ({ ...command })),
    extensionCount: snapshot.extensionCount,
    supportsImageInput: snapshot.supportsImageInput,
  };
}
