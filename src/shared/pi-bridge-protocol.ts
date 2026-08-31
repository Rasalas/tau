import type { ExtensionUiPromptKind, NewThreadRequestId, UiComposerCommand, UiTaskProgress, UiTaskProgressEntry } from "./contracts.js";

export const PI_BRIDGE_PROTOCOL_VERSION = 1;
export const PI_BRIDGE_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface PiBridgeDescriptor {
  protocolVersion: 1;
  epoch: string;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  pid: number;
  socketPath: string;
  token: string;
  startedAt: number;
}

export interface PiBridgeSnapshot {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  sessionName?: string;
  messages: unknown[];
  isStreaming: boolean;
  model?: { provider: string; id: string; name?: string };
  models: Array<{ provider: string; id: string; name?: string }>;
  thinkingLevel: string;
  thinkingLevels: string[];
  activeTools: string[];
  allTools: Array<{ name: string; description: string }>;
  /** Bridge-controlled Pi TUI currently cannot receive image prompt input. */
  supportsImageInput: false;
  /** Optional for compatibility with Pi instances running an older bridge. */
  composerCommands?: UiComposerCommand[];
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
  taskProgress?: UiTaskProgress;
  taskHistory?: UiTaskProgressEntry[];
  /** Set while Pi blocks on an extension question in its own terminal. */
  awaitingInput?: PiBridgeAwaitingInput;
  /** Token echoed once a registered new-session command has actually switched sessions. */
  newSessionRequestId?: NewThreadRequestId;
}

export type PiBridgeCommand =
  | { command: "prompt"; text: string; deliverAs?: "steer" | "followUp" }
  | { command: "abort" }
  | { command: "set_thinking"; level: string }
  | { command: "set_model"; provider: string; id: string }
  | { command: "compact" }
  | { command: "reload" }
  | { command: "set_session_name"; name: string }
  | { command: "fork"; entryId: string }
  | { command: "new_session"; initialPrompt?: string; requestId?: NewThreadRequestId }
  | { command: "export_markdown" }
  | { command: "snapshot" }
  | { command: "ping" };

/**
 * A blocking question Pi is waiting on. Pi owns its own UI context while it owns
 * the runtime, so the question itself is answered in Pi's terminal; Tau can only
 * report that the thread is stalled on it.
 */
export interface PiBridgeAwaitingInput {
  kind: ExtensionUiPromptKind;
  title?: string;
}

export type PiBridgeClientFrame =
  | { protocolVersion: 1; type: "hello"; id: string; epoch: string; token: string; expectedSessionId: string }
  | ({ protocolVersion: 1; type: "command"; id: string; epoch: string; expectedSessionId: string } & PiBridgeCommand);

export type PiBridgeServerFrame =
  | { protocolVersion: 1; type: "ready"; id: string; epoch: string; snapshot: PiBridgeSnapshot }
  | { protocolVersion: 1; type: "response"; id: string; epoch: string; ok: true; result?: unknown }
  | { protocolVersion: 1; type: "response"; id: string; epoch: string; ok: false; error: string }
  | { protocolVersion: 1; type: "event"; epoch: string; seq: number; sessionId: string; event: unknown }
  | { protocolVersion: 1; type: "snapshot"; epoch: string; seq: number; snapshot: PiBridgeSnapshot };

export function isPiBridgeDescriptor(value: unknown): value is PiBridgeDescriptor {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return item.protocolVersion === PI_BRIDGE_PROTOCOL_VERSION
    && typeof item.epoch === "string"
    && typeof item.sessionId === "string"
    && typeof item.sessionFile === "string"
    && typeof item.cwd === "string"
    && typeof item.pid === "number"
    && typeof item.socketPath === "string"
    && typeof item.token === "string"
    && typeof item.startedAt === "number";
}

export function encodePiBridgeFrame(frame: PiBridgeClientFrame | PiBridgeServerFrame): string {
  const encoded = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > PI_BRIDGE_MAX_FRAME_BYTES) {
    throw new Error("Pi bridge frame exceeds the size limit.");
  }
  return encoded;
}
