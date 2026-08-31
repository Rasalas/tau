import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  loadSkills,
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  AccessLevel,
  ExtensionUiAnswer,
  ExtensionUiPrompt,
  UiQuestionnaireQuestion,
  ServiceTier,
  CommitResult,
  DiffLoadOptions,
  FileNode,
  HostBootstrap,
  HostEvent,
  HostSnapshot,
  PushResult,
  ShellActionResult,
  ThreadIndexSnapshot,
  UiComposerCommand,
  UiEditor,
  UiFileDiff,
  UiMessage,
  UiMessageImage,
  UiModel,
  UiPromptAttachment,
  UiSession,
  UiToolRun,
  UiTurnActivity,
  UiWorkspaceChanges,
  WorkspaceInfo,
  ThreadBackendKind,
  PreparedPrompt,
} from "../shared/contracts.js";
import { HOST_PROTOCOL_VERSION, catalogFromSnapshot, detailFromSnapshot, type HostActionResult, type HostUpdate, type ThreadDetail, type TranscriptPage } from "../shared/host-protocol.js";
import { formatChatTranscript } from "../shared/chat-transcript.js";
import { mergeTaskProgressHistory, taskProgressFromMessages, taskProgressHistoryFromMessages } from "../shared/task-progress.js";
import { ThreadDetailStore } from "../shared/thread-detail-store.js";
import { TranscriptPager } from "../shared/transcript-pager.js";
import { HostLifecycleInstrumentation } from "./host-lifecycle.js";
import { RuntimeResourceCache, runtimeResourceFingerprint } from "./runtime-resource-cache.js";
import { cachedResourceOptions, captureResourceDiscovery, type ResourceDiscoverySnapshot } from "./resource-discovery-cache.js";
import { createAccessExtension, type AccessDecision } from "./access-extension.js";
import { computerUseExtensionFactories } from "./computer-use-extension.js";
import { createServiceTierExtension, SERVICE_TIER_APIS } from "./service-tier-extension.js";
import { createExtensionUiContext } from "./extension-ui.js";
import { findDanglingToolCalls } from "./dangling-tool-calls.js";
import { ThreadRuntimeRegistry } from "./thread-runtimes.js";
import { freeTextOption } from "../shared/extension-prompt-options.js";
import { createQuestionnaireExtension } from "./questionnaire-extension.js";
import { GitCoordinator } from "./git-coordinator.js";
import { ProjectHistory } from "./project-history.js";
import * as workspaceGit from "./workspace-git.js";
import { ToolOutputBatcher } from "./tool-output-batcher.js";
import { promptImages } from "./prompt-attachments.js";
import { findPiBridge, PiBridgeClient, PiBridgeReconnectLoop } from "./pi-bridge-client.js";
import type { PiBridgePreparedPrompt, PiBridgeServerFrame, PiBridgeSnapshot } from "../shared/pi-bridge-protocol.js";
import {
  branchMessagesWithClientMessageIds,
  clientMessageFingerprint,
  clientMessageCancelMarker,
  clientMessageIdForMessage,
  clientMessageMarker,
  matchClientMessageId,
  CLIENT_MESSAGE_CANCEL_MARKER,
  CLIENT_MESSAGE_MARKER,
  unclaimedClientMessageIds,
} from "../shared/client-message-correlation.js";
import {
  canonicalSkillName,
  normalizeSkillInvocationForRuntime,
  prepareSkillPrompt,
  skillInvocationCommand,
  skillMessagePresentation,
  visibleSkillEnvelopeText,
} from "./skill-invocation.js";
import { knownSkillNames } from "../shared/skill-envelope.js";
import { assertClaudePermissionPolicySupported, assertRuntimeAdapter, createClaudeCodeRuntimeAdapter, PI_AGENT_RUNTIME_ADAPTER, runtimePermissionPolicy, type AgentRuntimeAdapter } from "./runtime-adapters.js";
import { ClaudeRuntimeSessionStore, type ClaudeTitleSource } from "./claude-runtime-store.js";
import { ClaudeThreadRuntimeBackend, PiThreadRuntimeBackend, type ThreadRuntimeBackend } from "./thread-runtime-backend.js";

/** Live Pi runtimes kept in memory; idle ones beyond this are released oldest first. */
const MAX_LIVE_THREADS = 6;
/** Virtual shell paths keep app-data-owned Claude sessions addressable without
 * pretending their transcript is a Pi JSONL file. */
const CLAUDE_SESSION_PATH_PREFIX = "tau-claude-session:";
/** Longest a shutdown waits for a run to stop before the runtime is dropped anyway. */
const SHUTDOWN_ABORT_MS = 3_000;
/** How long a typed answer waits for the extension's follow-up input prompt. */
const TYPED_ANSWER_TTL_MS = 10_000;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "dist-electron", ".next"]);

function claudeSessionPath(sessionId: string): string {
  return `${CLAUDE_SESSION_PATH_PREFIX}${sessionId}`;
}

function claudeSessionIdFromPath(path: string): string | undefined {
  return path.startsWith(CLAUDE_SESSION_PATH_PREFIX)
    ? path.slice(CLAUDE_SESSION_PATH_PREFIX.length) || undefined
    : undefined;
}

type Emit = (event: HostEvent) => void;
type RuntimeStartEvent = Parameters<CreateAgentSessionRuntimeFactory>[0]["sessionStartEvent"];

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as { type?: string; text?: string; thinking?: string };
      if (item.type === "text") return item.text ?? "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const MESSAGE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function imagesFromContent(content: unknown): UiMessageImage[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const image = part as { type?: string; mimeType?: string; data?: string };
    if (
      image.type !== "image"
      || !image.mimeType
      || !MESSAGE_IMAGE_MIME_TYPES.has(image.mimeType)
      || typeof image.data !== "string"
      || image.data.length === 0
    ) return [];
    return [{ mimeType: image.mimeType, data: image.data }];
  }).slice(0, 4);
}

function thinkingFromContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const value = content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const item = part as { type?: string; thinking?: string };
      return item.type === "thinking" ? item.thinking ?? "" : "";
    })
    .filter(Boolean)
    .join("\n");
  return value || undefined;
}

export interface MessageMappingOptions {
  runtimeAdapter?: AgentRuntimeAdapter;
  skillCommands?: readonly UiComposerCommand[];
}

export interface PiHostOptions {
  /** Legacy default adapter. Existing Pi sessions are still always opened by Pi. */
  runtimeAdapter?: AgentRuntimeAdapter;
  /** Explicit adapters available to per-thread backend selection. */
  runtimeAdapters?: Partial<Record<ThreadBackendKind, AgentRuntimeAdapter>>;
  /** Backend for a newly created thread when no existing session metadata applies. */
  defaultBackendKind?: ThreadBackendKind;
  /** Commands available to the non-Pi backend; Pi discovers its own resources. */
  runtimeCommands?: readonly UiComposerCommand[];
}

export function mapMessage(message: unknown, index: number, options: MessageMappingOptions = {}): UiMessage | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = message as {
    role?: string;
    content?: unknown;
    timestamp?: number;
    customType?: string;
    tauEntryId?: string;
    clientMessageId?: string;
  };

  if (value.role === "user") {
    const text = textFromContent(value.content);
    const images = imagesFromContent(value.content);
    const presentation = options.runtimeAdapter && options.skillCommands
      ? skillMessagePresentation(text, options.runtimeAdapter, options.skillCommands)
      : undefined;
    const visibleText = presentation?.text ?? text;
    const clientMessageId = typeof value.clientMessageId === "string" && value.clientMessageId.length > 0
      ? value.clientMessageId
      : undefined;
    return {
      // Live events do not carry a persisted entry id yet. The request id is
      // already stable at message_start, so use it to keep equal-timestamp
      // user turns distinct until the next authoritative snapshot.
      id: value.tauEntryId ?? (clientMessageId ? `user-${clientMessageId}` : `user-${value.timestamp ?? index}-${index}`),
      sourceEntryId: value.tauEntryId,
      ...(clientMessageId ? { clientMessageId } : {}),
      role: "user",
      text: visibleText || (images.length ? `[${images.length} image${images.length === 1 ? "" : "s"} attached]` : ""),
      ...(presentation ? { skill: presentation.skill } : {}),
      images,
      timestamp: value.timestamp ?? Date.now(),
    };
  }

  if (value.role === "assistant") {
    return {
      id: value.tauEntryId ?? `assistant-${value.timestamp ?? index}-${index}`,
      sourceEntryId: value.tauEntryId,
      role: "assistant",
      text: textFromContent(value.content),
      thinking: thinkingFromContent(value.content),
      timestamp: value.timestamp ?? Date.now(),
    };
  }

  if (value.role === "custom" && value.customType) {
    return {
      id: value.tauEntryId ?? `notice-${value.timestamp ?? index}-${index}`,
      sourceEntryId: value.tauEntryId,
      role: "notice",
      text: textFromContent(value.content),
      timestamp: value.timestamp ?? Date.now(),
    };
  }

  return undefined;
}

export function lastTurnActivityFromMessages(messages: unknown[]): UiTurnActivity | undefined {
  let turnStart = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string } | undefined;
    if (message?.role === "user") {
      turnStart = index;
      break;
    }
  }
  if (turnStart < 0) return undefined;

  const tools: UiToolRun[] = [];
  const toolIndexes = new Map<string, number>();
  let anchorMessageId: string | undefined;
  let lastVisibleMessageId: string | undefined;

  for (let index = turnStart; index < messages.length; index += 1) {
    const raw = messages[index];
    if (!raw || typeof raw !== "object") continue;
    const message = raw as {
      role?: string;
      content?: unknown;
      timestamp?: number;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
    };
    const mapped = mapMessage(message, index);
    if (mapped && (mapped.role === "user" || mapped.text.trim())) lastVisibleMessageId = mapped.id;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || typeof part !== "object") continue;
        const call = part as { type?: string; id?: string; name?: string; arguments?: unknown };
        if (call.type !== "toolCall" || !call.id || !call.name) continue;
        anchorMessageId ??= lastVisibleMessageId;
        toolIndexes.set(call.id, tools.length);
        tools.push({
          id: call.id,
          name: call.name,
          args: call.arguments && typeof call.arguments === "object" ? call.arguments as Record<string, unknown> : {},
          status: "running",
          startedAt: message.timestamp ?? Date.now(),
        });
      }
    }

    if (message.role === "toolResult" && message.toolCallId) {
      const toolIndex = toolIndexes.get(message.toolCallId);
      if (toolIndex === undefined) continue;
      const tool = tools[toolIndex];
      const output = textFromContent(message.content);
      tools[toolIndex] = {
        ...tool,
        name: message.toolName ?? tool.name,
        status: message.isError ? "error" : "done",
        output: output.length > 8_192 ? `${output.slice(0, 8_192)}\n[Restored output truncated]` : output,
        endedAt: message.timestamp ?? tool.startedAt,
      };
    }
  }

  return tools.length > 0 ? { tools, anchorMessageId } : undefined;
}

function mapModel(model: { provider: string; id: string; name?: string }): UiModel {
  return { provider: model.provider, id: model.id, name: model.name ?? model.id };
}

function firstSentence(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return "Untitled thread";
  const sentenceEnd = normalized.search(/[.!?](?:\s|$)/u);
  const sentence = sentenceEnd >= 0 ? normalized.slice(0, sentenceEnd + 1) : normalized;
  return sentence.length > 96 ? `${sentence.slice(0, 93).trimEnd()}…` : sentence;
}

function visibleTitleText(value: string): string {
  const envelope = visibleSkillEnvelopeText(value);
  if (envelope !== undefined) return envelope;
  // A malformed wrapper or an attribute-like location has no trustworthy
  // title text. Keep runtime internals out of sidebar/title fallback rather
  // than echoing a raw tag or local path.
  return /<skill\b|\blocation\s*=/iu.test(value)
    ? "Skill invocation"
    : value;
}

function safeSessionTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { return cleanThreadTitle(visibleTitleText(value)); }
  catch { return undefined; }
}

function normalizeTranscriptMessage(message: unknown, mapping: MessageMappingOptions): unknown {
  if (!message || typeof message !== "object") return message;
  const value = message as { role?: string; content?: unknown };
  if (value.role !== "user" || typeof mapping.runtimeAdapter === "undefined" || !mapping.skillCommands) return message;
  const text = textFromContent(value.content);
  const presentation = skillMessagePresentation(text, mapping.runtimeAdapter, mapping.skillCommands);
  // The normal timeline only classifies known skills. Export has a stricter
  // boundary: a complete runtime envelope is still an implementation detail
  // even when its skill disappeared from the current command registry. Keep
  // only its visible suffix; malformed/fenced lookalikes stay byte-for-byte.
  const visibleText = presentation?.text ?? visibleSkillEnvelopeText(text);
  if (visibleText === undefined) return message;
  const images = Array.isArray(value.content)
    ? value.content.filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "image")
    : [];
  return {
    ...value,
    content: [
      ...(visibleText ? [{ type: "text", text: visibleText }] : []),
      ...images,
    ],
  };
}

interface TitleMessage {
  role?: string;
  content?: unknown;
}

export function buildTitleConversation(
  runtimeMessages: readonly TitleMessage[],
  persistedMessages: readonly TitleMessage[] = [],
): string {
  function render(messages: readonly TitleMessage[]): string {
    return messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => {
        const text = textFromContent(message.content);
        return `${message.role}: ${message.role === "user" ? visibleTitleText(text) : text}`;
      })
      .filter((line) => line.trim().length > line.indexOf(":") + 1)
      .slice(0, 4)
      .join("\n\n")
      .slice(0, 6000);
  }
  return render(runtimeMessages) || render(persistedMessages);
}

export function cleanThreadTitle(value: string): string {
  const firstLine = value.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
  const title = firstLine
    .replace(/^\s*(?:#{1,6}|>|[-+*])\s+/u, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/(?:\*\*|__|~~|`)+/gu, "")
    .replace(/^(?:(?:the\s+)?(?:thread\s+)?title|titel)\s*(?:is|lautet)?\s*[:\-]\s*/iu, "")
    .replace(/^["'“”‘’]+|["'“”‘’]+$/gu, "")
    .replace(/[.!?:;]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!title) throw new Error("The title model returned an empty title.");
  return title.length > 80 ? `${title.slice(0, 77).trimEnd()}…` : title;
}

async function mapSessions(
  sessions: SessionInfo[],
  fallbackCwd: string,
  resolveBranch: (cwd: string) => Promise<string | undefined>,
  resolveProjectName: (cwd: string) => string = (cwd) => basename(cwd) || cwd,
): Promise<UiSession[]> {
  const recent = [...sessions]
    .sort((a, b) => b.modified.getTime() - a.modified.getTime())
    .slice(0, 80);
  const projectPaths = [...new Set(recent.map((session) => session.cwd || fallbackCwd))];
  const branches = new Map(
    await Promise.all(projectPaths.map(async (path) => [path, await resolveBranch(path)] as const)),
  );
  return recent.map((session) => {
    const projectPath = session.cwd || fallbackCwd;
    return {
      id: session.id,
      path: session.path,
      title: cleanThreadTitle(safeSessionTitle(session.name) || firstSentence(visibleTitleText(session.firstMessage))),
      modifiedAt: session.modified.getTime(),
      projectPath,
      projectName: resolveProjectName(projectPath),
      branch: branches.get(projectPath),
      messageCount: session.messageCount,
      backendKind: "pi",
    };
  });
}

function sessionShellEqual(left: UiSession, right: UiSession): boolean {
  return left.id === right.id && left.path === right.path && left.title === right.title &&
    left.modifiedAt === right.modifiedAt && left.projectPath === right.projectPath &&
    left.projectName === right.projectName && left.branch === right.branch &&
    left.messageCount === right.messageCount && left.backendKind === right.backendKind;
}

export function sessionIndexUpdates(previous: UiSession[], next: UiSession[]): HostUpdate[] {
  const previousById = new Map(previous.map((session) => [session.id, session] as const));
  const nextById = new Map(next.map((session) => [session.id, session] as const));
  const updates: HostUpdate[] = [];
  for (const shell of next) {
    const old = previousById.get(shell.id);
    if (!old || !sessionShellEqual(old, shell)) {
      updates.push({ version: HOST_PROTOCOL_VERSION, type: "thread-shell", update: { sessionId: shell.id, shell } });
    }
  }
  for (const shell of previous) {
    if (!nextById.has(shell.id)) {
      updates.push({ version: HOST_PROTOCOL_VERSION, type: "thread-shell", update: { sessionId: shell.id, removed: true } });
    }
  }
  return updates;
}

export interface ActiveThreadShellInput {
  id: string;
  path: string;
  explicitTitle?: string;
  derivedTitle: string;
  now: number;
  projectPath: string;
  projectName: string;
  branch?: string;
  messageCount: number;
  backendKind?: ThreadBackendKind;
}

export function reconcileActiveThreadShell(
  input: ActiveThreadShellInput,
  existing: UiSession | undefined,
  touch: boolean,
): UiSession {
  return {
    id: input.id,
    path: input.path,
    title: input.explicitTitle || (!touch ? existing?.title : undefined) || input.derivedTitle,
    modifiedAt: touch ? input.now : existing?.modifiedAt ?? input.now,
    projectPath: input.projectPath,
    projectName: input.projectName,
    branch: input.branch,
    messageCount: input.messageCount,
    ...(input.backendKind ? { backendKind: input.backendKind } : {}),
  };
}

export function mergeSessionIndexScan(
  scanned: UiSession[],
  current: UiSession[],
  scanStartedAt: number,
  keepIds: ReadonlySet<string> = new Set(),
): UiSession[] {
  // A thread that only lives in memory (a new one without its first message)
  // has no file for the scan to find; it must survive on its live state alone.
  const newer = new Map(current
    .filter((session) => session.modifiedAt >= scanStartedAt || keepIds.has(session.id))
    .map((session) => [session.id, session]));
  const merged = scanned.map((session) => newer.get(session.id) ?? session);
  const scannedIds = new Set(merged.map((session) => session.id));
  for (const session of newer.values()) {
    if (!scannedIds.has(session.id)) merged.push(session);
  }
  return merged;
}

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

export async function assertWorkspacePath(cwd: string, path: string): Promise<void> {
  const target = resolve(cwd, path);
  if (!within(cwd, target)) throw new Error("Path is outside the workspace.");
  const rootReal = await realpath(cwd);
  let probe = target;
  while (true) {
    try {
      if (!within(rootReal, await realpath(probe))) throw new Error("Path is outside the workspace.");
      return;
    } catch (error) {
      if (error instanceof Error && error.message === "Path is outside the workspace.") throw error;
      if (probe === cwd) throw error;
      probe = dirname(probe);
    }
  }
}

function approvalSummary(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash" || toolName === "powershell") return String(input.command ?? "shell command");
  const path = input.path;
  if (typeof path === "string") return path;
  return Object.keys(input).join(" · ") || toolName;
}

function resultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  return textFromContent(content);
}

export const MAX_HOST_TOOL_OUTPUT_BYTES = 128 * 1024;
export function boundedToolOutput(output: string): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= MAX_HOST_TOOL_OUTPUT_BYTES) return output;
  const tail = bytes.subarray(bytes.length - MAX_HOST_TOOL_OUTPUT_BYTES).toString("utf8");
  return `[Earlier tool output truncated by host; showing the latest ${MAX_HOST_TOOL_OUTPUT_BYTES} bytes.]\n${tail}`;
}

interface LiveAssistant {
  id: string;
  text: string;
  thinking: string;
  timestamp: number;
}

/** In-flight state of one thread's current turn, whichever process runs it. */
interface LiveTurnState {
  readonly tools: Map<string, UiToolRun>;
  currentAssistantId?: string;
  /** Assistant text still streaming, so a thread opened mid-turn shows it. */
  liveAssistant?: LiveAssistant;
}

/**
 * One Pi runtime bound to one session for the runtime's whole life. Threads
 * never share a runtime, so switching the workbench between them never aborts
 * or replaces anything — it only changes which one is on screen.
 */
class ThreadRuntime implements LiveTurnState {
  readonly tools = new Map<string, UiToolRun>();
  readonly pendingClientMessageIds: string[] = [];
  pendingClientMessageFingerprints = new Map<string, string>();
  /** Markers assigned at message_start but not finalized at message_end yet. */
  readonly inFlightClientMessageIds = new Set<string>();
  adapterMessages: UiMessage[] = [];
  adapterTitle?: string;
  adapterTitleSource?: ClaudeTitleSource;
  adapterStreaming = false;
  adapterPending = 0;
  adapterAbortGeneration = 0;
  adapterAbortControllers = new Set<AbortController>();
  adapterQueue: Promise<void> = Promise.resolve();
  currentAssistantId?: string;
  liveAssistant?: LiveAssistant;
  unsubscribe?: () => void;

  constructor(
    readonly backend: ThreadRuntimeBackend,
    readonly runtime?: AgentSessionRuntime,
  ) {}

  get runtimeAdapter(): AgentRuntimeAdapter { return this.backend.runtimeAdapter; }
  get session(): AgentSession {
    if (!this.runtime) throw new Error("This thread is owned by a non-Pi runtime.");
    return this.runtime.session;
  }
  get sessionId(): string { return this.backend.sessionId; }
  get cwd(): string { return this.backend.cwd; }
  get sessionFile(): string | undefined {
    return this.backend.kind === "pi" && this.runtime
      ? this.session.sessionFile ?? this.session.sessionManager.getSessionFile()
      : undefined;
  }

  resetLiveState(): void {
    this.tools.clear();
    this.pendingClientMessageIds.length = 0;
    this.pendingClientMessageFingerprints.clear();
    this.inFlightClientMessageIds.clear();
    this.adapterAbortControllers.clear();
    this.currentAssistantId = undefined;
    this.liveAssistant = undefined;
  }
}

function isThreadRuntime(thread: LiveTurnState | undefined): thread is ThreadRuntime {
  // The bridge has a deliberately smaller live-state carrier. Only an owned
  // Pi backend has a Session/AgentSessionRuntime whose events can be handled
  // here; external runtimes publish their own normalized messages.
  if (!thread || !("backend" in thread)) return false;
  const candidate = thread as ThreadRuntime;
  return candidate.backend.kind === "pi" && Boolean(candidate.runtime);
}

function threadBackendKind(thread: ThreadRuntime | LiveTurnState | undefined): ThreadBackendKind {
  if (thread && "backend" in thread && thread.backend) return thread.backend.kind;
  return thread && "runtimeAdapter" in thread && thread.runtimeAdapter.id === "claude-code" ? "claude-code" : "pi";
}

function isPiBackend(thread: ThreadRuntime | LiveTurnState | undefined): boolean {
  return threadBackendKind(thread) === "pi";
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right) && resolve(left!) === resolve(right!);
}

export class PiHost {
  private cwd: string;
  /** Adapters are selected once, then each thread permanently owns one backend. */
  private readonly runtimeAdapters: Record<ThreadBackendKind, AgentRuntimeAdapter>;
  private readonly defaultBackendKind: ThreadBackendKind;
  private readonly runtimeCommands: readonly UiComposerCommand[];
  private readonly claudeStore: ClaudeRuntimeSessionStore;
  private emit: Emit;
  private bridge?: PiBridgeClient;
  private bridgeSnapshot?: PiBridgeSnapshot;
  /** Set while Tau deliberately takes a thread over from Pi, so it does not re-attach. */
  private suppressBridgeAttach = false;
  private readonly bridgeReconnectLoop = new PiBridgeReconnectLoop();
  private bridgeUnsubscribe?: () => void;
  private readonly agentDir = getAgentDir();
  private extensionCount = 0;
  private readonly lifecycleMetrics = new HostLifecycleInstrumentation();
  private readonly gitCoordinator = new GitCoordinator({ onSubprocess: () => this.lifecycleMetrics.countSubprocess() });
  private readonly modelCatalogCache = new RuntimeResourceCache<UiModel[]>({ maxEntries: 8, ttlMs: 5 * 60_000 });
  private readonly resourceDiscoveryCache = new RuntimeResourceCache<ResourceDiscoverySnapshot>({ maxEntries: 4, ttlMs: 5 * 60_000 });
  private readonly threads = new ThreadRuntimeRegistry<ThreadRuntime>({
    maxLive: MAX_LIVE_THREADS,
    // A thread with work in flight, an open question, or nothing saved yet has
    // state that only its runtime holds; releasing it would lose that state.
    canEvict: (record) => (record.runtime.backend?.isIdle?.() ?? true)
      && !this.hasOpenUiPrompts(record.sessionId)
      && record.runtime.adapterPending === 0
      && !record.runtime.adapterStreaming
      // An external runtime owns its transcript in the app-data store rather
      // than in Pi's message array. It is therefore safe to release once its
      // own visible projection has been persisted.
      && ((record.runtime.runtime?.session.messages.length ?? 0) > 0 || (record.runtime.adapterMessages?.length ?? 0) > 0),
    dispose: (record) => this.disposeThread(record.runtime),
  });
  /** Runtimes being opened, keyed by session file, so a prewarm and a switch share one. */
  private readonly openingThreads = new Map<string, Promise<ThreadRuntime>>();
  /** A blank runtime for the current project, so a new thread is ready before it is asked for. */
  private spare?: { cwd: string; pending: Promise<ThreadRuntime | undefined> };
  /** Session managers whose runtime is being built in the background, outside any measurement. */
  private readonly backgroundManagers = new WeakSet<SessionManager>();
  private readonly backgroundLifecycle: Array<{ name: string; durationMs: number }> = [];
  private prewarmTimer?: ReturnType<typeof setTimeout>;
  private sessions: UiSession[] = [];
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private threadIndexRefresh?: Promise<ThreadIndexSnapshot>;
  private readonly detailStore = new ThreadDetailStore(5);
  private activeIndexPublish?: ReturnType<typeof setTimeout>;
  private indexRecoveryTimer?: ReturnType<typeof setInterval>;
  private projectBranch?: string;
  /** Last known branch per project. Git is never awaited on an interactive path. */
  private readonly knownBranches = new Map<string, string | undefined>();
  private readonly branchRefreshes = new Map<string, Promise<void>>();
  /** A linked worktree keeps the repository's project name instead of becoming a new project. */
  private readonly knownProjectNames = new Map<string, string>();
  private readonly pendingShellUpdates = new Map<string, UiSession>();
  private accessLevel: AccessLevel = "full";
  private serviceTier: ServiceTier = "standard";
  private pendingApprovals = new Map<string, { sessionId: string; settle: (decision: AccessDecision) => void }>();
  private pendingUiPrompts = new Map<string, { sessionId: string; settle: (answer: ExtensionUiAnswer) => void }>();
  /** Prompts still awaiting an answer, kept so a late subscriber still sees them. */
  private openUiPrompts = new Map<string, ExtensionUiPrompt>();
  /** Free text typed for a select, waiting to answer the extension's follow-up input. */
  private typedAnswers = new Map<string, { text: string; expiresAt: number }>();
  /** Set by the app shell so extensions can retitle the window. */
  onWindowTitle?: (title: string) => void;
  private approvalCounter = 0;
  private readonly toolOutputBatcher: ToolOutputBatcher;
  private readonly toolOwners = new Map<string, string>();
  private readonly createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const reason = sessionStartEvent?.reason ?? "initial";
    const scenario = reason === "initial" ? "bootstrap" : reason === "resume" ? "cold-switch" : "warm-switch";
    const ownsMeasurement = !this.lifecycleMetrics.isActive() && !this.backgroundManagers.has(sessionManager);
    if (ownsMeasurement) this.lifecycleMetrics.begin(this.safeMode ? "safe" : "full", scenario);
    const totalStartedAt = performance.now();

    const settingsStartedAt = performance.now();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    this.logRuntimePhase("settings", settingsStartedAt, reason, cwd);

    const modelsStartedAt = performance.now();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    this.logRuntimePhase("models", modelsStartedAt, reason, cwd);

    const resourcesStartedAt = performance.now();
    const resourceKey = this.resourceFingerprint(cwd, settingsManager);
    const cachedResources = this.resourceDiscoveryCache.get(resourceKey);
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: {
        ...(cachedResources ? cachedResourceOptions(cachedResources) : {}),
        noExtensions: this.safeMode,
        // Inline factories load even in safe mode, so the access gate is never bypassed.
        extensionFactories: [
          { name: "tau-access", factory: this.accessExtension },
          { name: "tau-service-tier", factory: this.serviceTierExtension },
          { name: "tau-questionnaire", factory: this.questionnaireExtension },
          ...(this.safeMode ? [] : computerUseExtensionFactories(settingsManager)),
        ],
      },
    });
    if (!cachedResources) this.resourceDiscoveryCache.set(resourceKey, captureResourceDiscovery(services.resourceLoader));
    this.logRuntimePhase(cachedResources ? "resources-cache-hit" : "resources", resourcesStartedAt, reason, cwd);

    const sessionStartedAt = performance.now();
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    });
    this.logRuntimePhase("session", sessionStartedAt, reason, cwd);
    this.logRuntimePhase("total", totalStartedAt, reason, cwd);
    if (ownsMeasurement) this.lifecycleMetrics.end();

    return {
      ...created,
      services,
      diagnostics: services.diagnostics,
    };
  };

  private readonly accessExtension = createAccessExtension({
    level: () => this.accessLevel,
    onBlocked: (toolName, reason) => this.log("access.blocked", `${toolName}: ${reason}`),
    requestApproval: (toolCallId, toolName, input, sessionId) => this.requestApproval(toolCallId, toolName, input, sessionId),
  });

  /** Questionnaires announced per thread, and how many of their questions were asked so far. */
  private readonly questionnaires = new Map<string, { questions: UiQuestionnaireQuestion[]; asked: number }>();

  private readonly questionnaireExtension = createQuestionnaireExtension({
    onQuestionnaire: (sessionId, questions) => this.questionnaires.set(sessionId, { questions, asked: 0 }),
    onCleared: (sessionId) => this.questionnaires.delete(sessionId),
  });

  /** Threads and models the priority tier was already reported for; every request applies it. */
  private readonly serviceTierReported = new Set<string>();

  private readonly serviceTierExtension = createServiceTierExtension({
    fastRequested: () => this.serviceTier === "fast",
    available: () => this.serviceTierAvailable(),
    onApplied: (scope) => {
      if (this.serviceTierReported.has(scope)) return;
      this.serviceTierReported.add(scope);
      this.log("service-tier.applied", `priority · ${scope.slice(0, 8)}${scope.slice(36)}`);
    },
  });

  constructor(
    cwd: string,
    emit: Emit,
    private readonly projectHistory: ProjectHistory,
    private readonly safeMode = false,
    private readonly automaticPrewarm = true,
    options: PiHostOptions = {},
  ) {
    this.cwd = cwd;
    const selectedAdapter = this.safeMode ? PI_AGENT_RUNTIME_ADAPTER : options.runtimeAdapter ?? PI_AGENT_RUNTIME_ADAPTER;
    const configured = assertRuntimeAdapter(selectedAdapter);
    const configuredAdapters = options.runtimeAdapters ?? {};
    const piAdapter = assertRuntimeAdapter(configuredAdapters.pi ?? PI_AGENT_RUNTIME_ADAPTER);
    const configuredClaude = configuredAdapters["claude-code"]
      ? assertRuntimeAdapter(configuredAdapters["claude-code"])
      : configured.id === "claude-code" ? configured : undefined;
    if (configuredClaude && configuredClaude.id !== "claude-code") throw new Error("Claude backend requires the Claude Code runtime adapter.");
    this.runtimeAdapters = {
      pi: piAdapter,
      "claude-code": configuredClaude ?? createClaudeCodeRuntimeAdapter(),
    };
    const claude = this.runtimeAdapters["claude-code"];
    this.claudeStore = claude.id === "claude-code" && claude.sessionStore
      ? claude.sessionStore
      : new ClaudeRuntimeSessionStore({ filePath: ClaudeRuntimeSessionStore.defaultPath(this.agentDir) });
    this.defaultBackendKind = this.safeMode ? "pi" : options.defaultBackendKind ?? configured.id;
    this.runtimeCommands = options.runtimeCommands ?? [];
    this.emit = (event) => {
      this.lifecycleMetrics.recordIpc(event);
      emit(event);
    };
    this.toolOutputBatcher = new ToolOutputBatcher((updates) => {
      for (const [id, output] of updates) {
        this.emit({ type: "tool-update", sessionId: this.toolOwners.get(id) ?? "", id, output });
      }
    });
  }

  private adapterFor(kind: ThreadBackendKind): AgentRuntimeAdapter {
    return this.runtimeAdapters[kind];
  }

  // ---------------------------------------------------------------------------
  // Active thread accessors. Most of the host reads "the runtime": it is the one
  // the workbench shows, or nothing while Pi's own TUI owns the visible thread.
  // ---------------------------------------------------------------------------

  private get active(): ThreadRuntime | undefined {
    return this.threads.active?.runtime;
  }

  private get runtime(): AgentSessionRuntime | undefined {
    return this.active?.runtime;
  }

  private requireActive(): ThreadRuntime {
    const thread = this.active;
    if (!thread) throw new Error("Pi runtime is not ready");
    return thread;
  }

  private requireRuntime(): AgentSessionRuntime {
    const runtime = this.requireActive().runtime;
    if (!runtime) throw new Error("This thread is owned by a non-Pi runtime.");
    return runtime;
  }

  private requireSession(): AgentSession {
    return this.requireActive().session;
  }

  private threadFor(sessionId: string | undefined): ThreadRuntime | undefined {
    if (!sessionId) return this.active;
    return this.threads.get(sessionId)?.runtime;
  }

  private requireThread(sessionId: string | undefined): ThreadRuntime {
    const thread = this.threadFor(sessionId);
    if (!thread) {
      throw new Error(sessionId && sessionId !== this.active?.sessionId
        ? "That thread is not open any more. Open it again to continue."
        : "Pi runtime is not ready");
    }
    return thread;
  }

  /** Whether a command for `sessionId` belongs to the thread Pi's TUI owns. */
  private bridgeOwns(sessionId: string | undefined): boolean {
    return this.adapterFor("pi").id === "pi" && Boolean(this.bridge) && (!sessionId || sessionId === this.bridgeSnapshot?.sessionId);
  }

  private liveThreadForPath(path: string | undefined): ThreadRuntime | undefined {
    if (!path) return undefined;
    const storedSessionId = claudeSessionIdFromPath(path);
    if (storedSessionId) return this.threads.get(storedSessionId)?.runtime;
    const indexed = this.sessions.find((session) => session.path === path);
    if (indexed?.backendKind === "claude-code") return this.threads.get(indexed.id)?.runtime;
    return this.threads.list().find((record) => samePath(record.runtime.sessionFile, path))?.runtime;
  }

  private liveSessionIds(): Set<string> {
    return new Set(this.threads.list().map((record) => record.sessionId));
  }

  private claudeSessionStore(): ClaudeRuntimeSessionStore | undefined {
    return this.claudeStore;
  }

  private async initialSessionManager(cwd: string): Promise<SessionManager> {
    return SessionManager.continueRecent(cwd);
  }

  private async openInitialThread(cwd: string): Promise<ThreadRuntime> {
    if (this.defaultBackendKind === "claude-code") {
      const latest = (await this.claudeStore.list(cwd))[0];
      return this.openClaudeThread(latest?.tauSessionId ?? randomUUID(), cwd, { resume: Boolean(latest) });
    }
    return this.openThread(await this.initialSessionManager(cwd), undefined);
  }

  async start(): Promise<HostBootstrap> {
    return this.runLifecycle(async () => {
      this.lifecycleMetrics.begin(this.safeMode ? "safe" : "full", "bootstrap");
      try {
        await this.rememberProject(this.cwd);
        const safeModeOwner = this.safeMode ? await findPiBridge(this.cwd) : undefined;
        if (safeModeOwner && processIsAlive(safeModeOwner.pid)) {
          throw new Error("Pi already owns this session. Close Pi before opening the project in Tau safe mode.");
        }
        if (this.defaultBackendKind !== "pi" || !(await this.attachAvailableBridge(this.cwd))) {
          const thread = await this.openInitialThread(this.cwd);
          await this.activateThread(thread, false);
        }
        this.branchFor(this.cwd);
        const indexStartedAt = performance.now();
        this.log("bootstrap.first-content");
        // The global index is independent of the active detail. Publish it when
        // ready rather than making first content wait for every session file.
        void this.refreshThreadIndex(true).then(() => {
          this.recordBackgroundLifecycle("session-index", indexStartedAt);
          this.log("bootstrap.full-ready");
          this.startIndexRecovery();
          this.scheduleRuntimePrewarm();
        }).catch((error) => this.fail(error));
        const result = await this.bootstrap();
        this.lifecycleMetrics.end();
        return result;
      } catch (error) {
        this.lifecycleMetrics.end();
        throw error;
      }
    });
  }

  async bootstrap(): Promise<HostBootstrap> {
    const host = { ...this.snapshotSync(await this.ensureModels()), branch: this.projectBranch };
    const detail = this.detailForSnapshot(host);
    const result: HostBootstrap = {
      threadIndex: this.threadIndexSnapshot(),
      version: HOST_PROTOCOL_VERSION,
      detail,
      catalog: catalogFromSnapshot(host),
      project: { cwd: host.cwd, branch: host.branch },
    };
    this.lifecycleMetrics.recordIpc(result);
    return result;
  }

  /** Focused active detail endpoint; it never includes catalogs or project metadata. */
  async getThreadDetail(cursor?: string): Promise<TranscriptPage | ThreadDetail> {
    const snapshot = await this.snapshot();
    const result = cursor !== undefined
      ? TranscriptPager.pageFor(snapshot.sessionId, snapshot.messages, 40, cursor)
      : this.detailForSnapshot(snapshot);
    this.lifecycleMetrics.recordIpc(result);
    return result;
  }

  async loadTranscript(sessionId: string, cursor?: string): Promise<TranscriptPage> {
    const messages = this.bridgeOwns(sessionId) && this.bridgeSnapshot
      ? this.bridgeHostSnapshot().messages
      : this.messageSnapshot(this.requireThread(sessionId));
    const result = TranscriptPager.pageFor(sessionId, messages, 40, cursor);
    this.lifecycleMetrics.recordIpc(result);
    return result;
  }

  getLifecycleMeasurements() { return this.lifecycleMetrics.getMeasurements(); }
  getBackgroundLifecycleMeasurements() { return this.backgroundLifecycle.map((item) => ({ ...item })); }

  private detailForSnapshot(snapshot: HostSnapshot): ThreadDetail {
    // A fresh runtime snapshot is authoritative; only the renderer uses the
    // cached record for optimistic selection between host confirmations.
    const detail = detailFromSnapshot(snapshot);
    this.detailStore.set(detail);
    return detail;
  }

  private actionResult(updates: HostUpdate[]): HostActionResult {
    const result = { version: HOST_PROTOCOL_VERSION, updates } satisfies HostActionResult;
    this.lifecycleMetrics.recordIpc(result);
    return result;
  }

  private lifecycleUpdates(snapshot: HostSnapshot): HostUpdate[] {
    const shell = this.sessions.find((thread) => thread.id === snapshot.sessionId);
    return [
      ...(shell ? [{ version: HOST_PROTOCOL_VERSION, type: "thread-shell" as const, update: { sessionId: shell.id, shell } }] : []),
      { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) },
      { version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) },
      { version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd: snapshot.cwd, branch: snapshot.branch } },
    ];
  }

  private async activeUpdates(): Promise<HostActionResult> {
    return this.actionResult(this.lifecycleUpdates(await this.snapshot()));
  }

  async setWorkspace(cwd: string): Promise<HostActionResult> {
    return this.runLifecycle(() => this.setWorkspaceNow(cwd));
  }

  private async setWorkspaceNow(cwd: string): Promise<HostActionResult> {
    await this.rememberProject(cwd);
    if (cwd === this.cwd && (this.bridge || this.active)) return this.activeUpdates();
    if (this.defaultBackendKind === "pi" && await this.attachAvailableBridge(cwd)) {
      await this.rememberProject(this.cwd);
      await this.refreshActiveThreadIndex(false);
      return this.activeUpdates();
    }
    this.detachBridge();
    const startedAt = performance.now();
    const thread = this.defaultBackendKind === "claude-code"
      ? await this.openInitialThread(cwd)
      : await (async () => {
        const manager = await this.initialSessionManager(cwd);
        return this.liveThreadForPath(manager.getSessionFile())
          ?? await this.openThread(manager, { type: "session_start", reason: "resume", previousSessionFile: this.active?.sessionFile });
      })();
    await this.activateThread(thread, false);
    this.logReplacement("workspace", startedAt);
    return this.activeUpdates();
  }

  async removeProject(path: string): Promise<HostActionResult> {
    await this.projectHistory.remove(path);
    const update: HostUpdate = {
      version: HOST_PROTOCOL_VERSION,
      type: "thread-index",
      index: this.threadIndexSnapshot(),
    };
    this.emitUpdate(update);
    return this.actionResult([update]);
  }

  /**
   * A bridge peer that stops answering must not strand the workbench. Any command
   * that times out detaches, so the caller can fall back to Tau's own runtime.
   */
  private async bridgeCommand(command: Parameters<PiBridgeClient["command"]>[0]): Promise<unknown> {
    const bridge = this.bridge;
    if (!bridge) throw new Error("Pi bridge is not connected.");
    try {
      return await bridge.command(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/timed out|not connected|closed/iu.test(message)) throw error;
      this.log("bridge.unresponsive", command.command);
      this.detachBridge();
      throw new Error("Pi stopped responding, so Tau detached from it and now runs this thread itself.");
    }
  }

  /**
   * Closes tool calls left dangling by a turn that never finished, so the thread
   * can be used again. Without a result the provider rejects the next request.
   */
  async recoverThread(): Promise<HostActionResult> {
    // While Pi owns the thread its session file has another writer. Only take it
    // over when Pi has actually stopped answering; otherwise repair belongs there.
    if (this.bridge) {
      const sessionFile = this.bridge.descriptor.sessionFile;
      let responsive = true;
      try {
        await this.bridge.command({ command: "ping" }, 2_000);
      } catch {
        responsive = false;
      }
      // Only a run that is genuinely in flight is worth protecting: repairing
      // under Pi's feet mid-turn would race its writer. An idle or absent peer
      // is not using the session, so Tau takes it over to close the call.
      if (responsive && this.bridgeSnapshot?.isStreaming) {
        throw new Error("Pi is running this thread right now. Stop the run in Pi, then try again.");
      }
      this.log(responsive ? "bridge.takeover" : "bridge.unresponsive", "recover_thread");
      this.detachBridge();
      this.suppressBridgeAttach = true;
      try {
        await this.switchSession(sessionFile);
      } finally {
        this.suppressBridgeAttach = false;
      }
    }

    const thread = this.requireActive();
    return this.threads.run(thread.sessionId, async () => {
      if (!isPiBackend(thread)) {
        if (thread.adapterPending > 0 || thread.backend.isStreaming()) await this.abortThread(thread);
        thread.adapterMessages = await thread.backend.transcript();
        const snapshot = await this.snapshot();
        const update: HostUpdate = { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) };
        this.emitUpdate(update);
        return this.actionResult([update]);
      }
      const session = thread.session;
      // A run that is still in flight owns its tool calls; closing them from
      // outside would race the runtime. Stop it first, then repair.
      if (!session.isIdle || thread.adapterPending > 0) await this.abortThread(thread);
      // Zero dangling calls is a success: the session is already consistent and
      // the caller only has stale activity to clear.
      const dangling = findDanglingToolCalls(session.messages);
      for (const { toolCallId, toolName } of dangling) {
        session.sessionManager.appendMessage({
          role: "toolResult",
          toolCallId,
          toolName,
          content: [{ type: "text", text: "Interrupted: Tau closed this tool call so the thread could continue." }],
          isError: true,
          timestamp: Date.now(),
        } as never);
      }
      thread.tools.clear();
      this.log("thread.recovered", dangling.length === 0
        ? "session already consistent"
        : `${dangling.length} tool ${dangling.length === 1 ? "call" : "calls"}`);
      const snapshot = await this.snapshot();
      const update: HostUpdate = { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) };
      this.emitUpdate(update);
      return this.actionResult([update]);
    });
  }

  async newSession(
    initialPrompt?: string,
    attachments: UiPromptAttachment[] = [],
    cwd?: string,
    clientMessageId?: string,
    prepared?: PreparedPrompt,
  ): Promise<HostActionResult> {
    const backendKind = prepared?.backendKind ?? this.defaultBackendKind;
    if (backendKind === "pi" && this.bridge && (!cwd || cwd === this.cwd)) {
      if (attachments.length > 0) throw new Error("Image attachments are not supported while Tau is attached to Pi.");
      if (prepared) this.assertBridgePreparedPrompt(initialPrompt ?? "", prepared);
      try {
        await this.bridgeCommand({
          command: "new_session",
          initialPrompt,
          ...(clientMessageId ? { clientMessageId } : {}),
          ...(prepared ? { prepared: this.piBridgePreparedPrompt(prepared) } : {}),
        });
        return this.actionResult([]);
      } catch (error) {
        // A new thread is a different session, so Pi has no standing to veto it.
        // Whether it refused because it is busy or stopped answering entirely,
        // Tau creates the thread itself rather than leaving the user stuck.
        const reason = error instanceof Error ? error.message : String(error);
        this.log("bridge.fallback", `new_session: ${reason}`);
        this.detachBridge();
        this.emit({
          type: "notice",
          level: "info",
          message: "Pi could not take a new thread, so Tau created one itself and detached from Pi's session.",
        });
      }
    }
    return this.runLifecycle(async () => {
      const startedAt = performance.now();
      const targetCwd = cwd ?? this.cwd;
      this.detachBridge();
      const spare = backendKind === "pi" ? await this.takeSpareThread(targetCwd) : undefined;
      const thread = spare
        ?? (backendKind === "claude-code"
          ? await this.openClaudeThread(randomUUID(), targetCwd, { resume: false })
          : await this.openThread(
            SessionManager.create(targetCwd),
            { type: "session_start", reason: "new", previousSessionFile: this.active?.sessionFile },
          ));
      await this.activateThread(thread, true);
      // The first prompt names the thread right away; the run that follows
      // would otherwise leave it "Untitled" until it finishes.
      if (initialPrompt?.trim()) {
        const presentation = prepared?.skill ?? skillMessagePresentation(initialPrompt, thread.runtimeAdapter, this.composerCommands(thread));
        const visiblePrompt = prepared?.visibleText ?? (presentation && "text" in presentation ? presentation.text : visibleTitleText(initialPrompt));
        this.retitleShell(thread.sessionId, firstSentence(visiblePrompt));
      }
      this.logReplacement(spare ? "new-spare" : "new", startedAt);
      if (initialPrompt || attachments.length > 0) {
        const deliveryPrepared = prepared?.sessionId && prepared.sessionId !== thread.sessionId
          ? await thread.backend.preparePrompt(initialPrompt ?? "", prepared.skill?.name)
          : prepared;
        void this.prompt(initialPrompt ?? "", attachments, thread.sessionId, clientMessageId, deliveryPrepared).catch((error) => this.fail(error));
      }
      if (backendKind === "pi") this.scheduleSpareThread(targetCwd);
      return this.activeUpdates();
    });
  }

  async forkThread(entryId: string, expectedSessionId?: string): Promise<HostActionResult> {
    if (this.bridge) {
      if (expectedSessionId && this.bridgeSnapshot?.sessionId !== expectedSessionId) {
        throw new Error("The selected thread changed before it could be forked.");
      }
      await this.bridge.command({ command: "fork", entryId });
      return this.actionResult([]);
    }
    return this.runLifecycle(async () => {
      const thread = this.requireActive();
      if (expectedSessionId && thread.sessionId !== expectedSessionId) {
        throw new Error("The selected thread changed before it could be forked.");
      }
      if (!isPiBackend(thread)) throw new Error("Claude Code threads cannot be forked by the Pi session manager.");
      if (thread.session.isStreaming) throw new Error("Wait for the active run before forking this thread.");
      const sourceFile = thread.sessionFile;
      if (!sourceFile || !existsSync(sourceFile)) {
        throw new Error("This thread has not been saved yet. Wait for the first assistant response before forking it.");
      }
      const startedAt = performance.now();
      // The fork is a new session file, so it gets a runtime of its own; the
      // source thread keeps running untouched.
      const forkedPath = SessionManager.open(sourceFile).createBranchedSession(entryId);
      if (!forkedPath) throw new Error("Failed to create the forked thread.");
      const forked = await this.openThread(
        SessionManager.open(forkedPath),
        { type: "session_start", reason: "fork", previousSessionFile: sourceFile },
      );
      await this.activateThread(forked, true);
      this.logReplacement("fork", startedAt);
      return this.activeUpdates();
    });
  }

  async exportThreadMarkdown(expectedSessionId?: string): Promise<string> {
    if (this.bridge) {
      if (expectedSessionId && this.bridgeSnapshot?.sessionId !== expectedSessionId) {
        throw new Error("The selected thread changed before it could be copied.");
      }
      const result = await this.bridge.command({ command: "export_markdown" }) as {
        title?: unknown;
        cwd?: unknown;
        sessionId?: unknown;
        messages?: unknown;
      };
      if (!Array.isArray(result.messages)) throw new Error("Pi did not return a normalized chat transcript.");
      const messages = result.messages as Array<{ role?: string; content?: unknown }>;
      const explicitTitle = typeof result.title === "string"
        ? safeSessionTitle(result.title)
        : safeSessionTitle(this.bridgeSnapshot?.sessionName);
      const firstUserMessage = messages.find((message) => message.role === "user");
      return formatChatTranscript({
        title: explicitTitle || firstSentence(visibleTitleText(textFromContent(firstUserMessage?.content))),
        cwd: typeof result.cwd === "string" ? result.cwd : this.bridgeSnapshot?.cwd ?? this.cwd,
        sessionId: typeof result.sessionId === "string" ? result.sessionId : this.bridgeSnapshot?.sessionId ?? "",
        // The Pi bridge owns normalization against its live command registry.
        // Re-parsing here could reinterpret a legitimate visible `$skill ...`
        // instruction after the wrapper has already been removed.
        messages,
      });
    }
    const thread = this.requireThread(expectedSessionId);
    if (!isPiBackend(thread)) {
      const visibleMessages = await thread.backend.transcript();
      return formatChatTranscript({
        title: safeSessionTitle(thread.adapterTitle) || firstSentence(visibleTitleText(visibleMessages.find((message) => message.role === "user")?.text ?? "")),
        cwd: thread.cwd,
        sessionId: thread.sessionId,
        messages: visibleMessages.map((message) => ({ role: message.role, content: [{ type: "text", text: message.text }] })),
      });
    }
    const session = thread.session;
    const mapping = this.messageMappingOptions(thread);
    const persistedMessages = session.sessionManager.getBranch()
      .flatMap((entry) => entry.type === "message" ? [normalizeTranscriptMessage(entry.message, mapping)] : []) as Array<{ role?: string; content?: unknown }>;
    const adapterMessages = (thread.adapterMessages ?? []).map((message) => ({
      role: message.role,
      content: [{ type: "text", text: message.text }],
    }));
    const messages = [...persistedMessages, ...adapterMessages];
    return formatChatTranscript({
      title: safeSessionTitle(session.sessionName) || safeSessionTitle(thread.adapterTitle) || firstSentence(visibleTitleText(textFromContent(messages.find((message) => message.role === "user")?.content))),
      cwd: thread.cwd,
      sessionId: session.sessionId,
      messages,
    });
  }

  private async sendThroughRuntimeAdapter(
    thread: ThreadRuntime,
    text: string,
    attachments: UiPromptAttachment[],
    delivery: "prompt" | "steer" | "followUp",
    clientMessageId?: string,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    thread.adapterPending ??= 0;
    thread.adapterAbortGeneration ??= 0;
    const generation = thread.adapterAbortGeneration;
    const wasPending = thread.adapterPending > 0;
    thread.adapterPending += 1;
    thread.adapterStreaming = true;
    if (!wasPending) this.emit({ type: "agent-status", sessionId: thread.sessionId, running: true });
    const operation = thread.adapterQueue.then(() => {
      if (generation !== thread.adapterAbortGeneration) {
        if (clientMessageId) {
          this.emit({
            type: "user-message-failed",
            sessionId: thread.sessionId,
            clientMessageId,
            message: "The selected runtime request was aborted.",
          });
        }
        const error = new Error("The selected runtime request was aborted.");
        error.name = "AbortError";
        throw error;
      }
      return this.sendThroughRuntimeAdapterNow(thread, text, attachments, delivery, clientMessageId, prepared);
    });
    const settled = operation.finally(() => {
      thread.adapterPending = Math.max(0, thread.adapterPending - 1);
      if (thread.adapterPending === 0) {
        thread.adapterStreaming = false;
        this.emit({ type: "agent-status", sessionId: thread.sessionId, running: false });
      }
    });
    thread.adapterQueue = settled.then(() => undefined, () => undefined);
    return settled;
  }

  private async sendThroughRuntimeAdapterNow(
    thread: ThreadRuntime,
    text: string,
    attachments: UiPromptAttachment[],
    delivery: "prompt" | "steer" | "followUp",
    clientMessageId?: string,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    const commands = this.composerCommands(thread);
    if (prepared) this.assertPreparedPrompt(thread, text, prepared, commands);
    const abortController = new AbortController();
    thread.adapterAbortControllers ??= new Set<AbortController>();
    thread.adapterAbortControllers.add(abortController);
    try {
      if (attachments.length > 0) throw new Error("Image attachments are not supported by the selected runtime adapter.");
      if (!isPiBackend(thread)) {
        await thread.backend.prompt({ text, delivery, ...(clientMessageId ? { clientMessageId } : {}), ...(prepared ? { prepared } : {}), signal: abortController.signal });
        thread.adapterMessages = await thread.backend.transcript();
        const backendDetail = await thread.backend.detail();
        thread.adapterTitle = backendDetail.title;
        thread.adapterTitleSource = backendDetail.titleSource;
        await this.refreshThreadShell(thread, true);
        return;
      }
      throw new Error("Pi prompts must use the Pi session backend.");
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      if (clientMessageId) {
        this.emit({
          type: "user-message-failed",
          sessionId: thread.sessionId,
          clientMessageId,
          message: aborted ? "The selected runtime request was aborted." : "The selected runtime rejected the message.",
        });
      }
      if (!aborted) this.fail(error);
      throw error;
    } finally {
      thread.adapterAbortControllers.delete(abortController);
    }
  }

  /**
   * Prepared prompt data is an opaque host result, but IPC callers can still
   * replay or forge it. Bind it to the exact visible input and runtime owner
   * before allowing the backend to execute the runtime spelling.
   */
  private assertPreparedPrompt(
    thread: ThreadRuntime,
    text: string,
    prepared: PreparedPrompt,
    commands: readonly UiComposerCommand[],
  ): void {
    this.assertPreparedPromptData(
      text,
      prepared,
      threadBackendKind(thread),
      thread.sessionId,
      thread.runtimeAdapter,
      commands,
    );
  }

  private assertPreparedPromptData(
    text: string,
    prepared: PreparedPrompt,
    backendKind: ThreadBackendKind,
    sessionId: string | undefined,
    adapter: AgentRuntimeAdapter,
    commands: readonly UiComposerCommand[],
  ): void {
    if (prepared.backendKind !== backendKind
      || (prepared.sessionId !== undefined && prepared.sessionId !== sessionId)
      || prepared.runtimeCapabilities.skillInvocationDialect !== adapter.capabilities.skillInvocationDialect) {
      throw new Error("Prepared prompt belongs to another runtime.");
    }
    const skillNamesSet = knownSkillNames(commands);
    if (prepared.skill) {
      const name = canonicalSkillName(prepared.skill.name);
      if (!skillNamesSet.has(name)
        || prepared.skill.command !== skillInvocationCommand(name, adapter)
        || prepared.skill.copyText !== (prepared.visibleText ? `${prepared.skill.command} ${prepared.visibleText}` : prepared.skill.command)
        || prepared.runtimeText !== prepared.skill.copyText) {
        throw new Error(`The selected skill '${prepared.skill.name}' is no longer available in this runtime.`);
      }
    } else if (prepared.visibleText !== text || prepared.runtimeText !== text) {
      throw new Error("Prepared prompt no longer matches the message being sent.");
    }
    const skillNames = [...skillNamesSet];
    if (prepared.sourceFingerprint !== clientMessageFingerprint(text, skillNames)) {
      throw new Error("Prepared prompt no longer matches the message being sent.");
    }
  }

  /** Resolves a prompt before the renderer creates its optimistic message. */
  async preparePrompt(text: string, sessionId?: string, skillName?: string): Promise<PreparedPrompt> {
    if (this.bridgeOwns(sessionId)) {
      const result = await this.bridgeCommand({ command: "prepare_prompt", text, ...(skillName ? { skillName } : {}) });
      if (!result || typeof result !== "object") throw new Error("Pi bridge returned an invalid prepared prompt.");
      const prepared = result as Partial<PiBridgePreparedPrompt>;
      if (typeof prepared.visibleText !== "string" || typeof prepared.runtimeText !== "string" || typeof prepared.sourceFingerprint !== "string") {
        throw new Error("Pi bridge returned an invalid prepared prompt.");
      }
      return {
        sessionId: this.bridgeSnapshot?.sessionId,
        backendKind: "pi",
        runtimeCapabilities: prepared.runtimeCapabilities ?? PI_AGENT_RUNTIME_ADAPTER.capabilities,
        visibleText: prepared.visibleText,
        runtimeText: prepared.runtimeText,
        ...(prepared.skill ? { skill: prepared.skill } : {}),
        sourceFingerprint: prepared.sourceFingerprint,
      };
    }
    const target = sessionId
      ? this.requireThread(sessionId)
      : (this.active && threadBackendKind(this.active) === this.defaultBackendKind ? this.active : undefined);
    if (target?.backend) return target.backend.preparePrompt(text, skillName);
    if (target) {
      return this.preparePromptForAdapter(
        text,
        skillName,
        target.runtimeAdapter,
        this.composerCommands(target),
        target.sessionId,
        threadBackendKind(target),
      );
    }
    const adapter = this.adapterFor(this.defaultBackendKind);
    const commands = adapter.id === "claude-code"
      ? this.claudeComposerCommands(this.cwd)
      : this.runtimeCommands;
    return this.preparePromptForAdapter(text, skillName, adapter, commands, undefined, this.defaultBackendKind);
  }

  private preparePromptForAdapter(
    text: string,
    skillName: string | undefined,
    adapter: AgentRuntimeAdapter,
    commands: readonly UiComposerCommand[],
    sessionId: string | undefined,
    backendKind: ThreadBackendKind,
  ): PreparedPrompt {
    if (adapter.id === "claude-code") assertClaudePermissionPolicySupported(runtimePermissionPolicy(this.accessLevel));
    const effectiveCommands = commands;
    if (skillName && !knownSkillNames(commands).has(canonicalSkillName(skillName))) {
      throw new Error(`The selected skill '${skillName}' is no longer available in this runtime.`);
    }
    const prepared = prepareSkillPrompt(text, adapter, effectiveCommands);
    const skillNames = [...knownSkillNames(effectiveCommands)];
    return {
      ...(sessionId ? { sessionId } : {}),
      backendKind,
      runtimeCapabilities: adapter.capabilities,
      visibleText: prepared.text,
      runtimeText: prepared.runtimeText,
      ...(prepared.skill ? { skill: prepared.skill } : {}),
      sourceFingerprint: clientMessageFingerprint(text, skillNames),
    };
  }

  private piBridgePreparedPrompt(prepared: PreparedPrompt): PiBridgePreparedPrompt {
    if (prepared.backendKind !== "pi") throw new Error("Prepared prompt belongs to another runtime.");
    return {
      visibleText: prepared.visibleText,
      runtimeText: prepared.runtimeText,
      runtimeCapabilities: prepared.runtimeCapabilities,
      ...(prepared.skill ? { skill: prepared.skill } : {}),
      sourceFingerprint: prepared.sourceFingerprint,
    };
  }

  private assertBridgePreparedPrompt(text: string, prepared: PreparedPrompt, sessionId?: string): void {
    this.assertPreparedPromptData(
      text,
      prepared,
      "pi",
      sessionId,
      PI_AGENT_RUNTIME_ADAPTER,
      this.composerCommandsForAdapter(this.bridgeSnapshot?.composerCommands ?? [], PI_AGENT_RUNTIME_ADAPTER),
    );
  }

  async switchSession(path: string): Promise<HostActionResult> {
    // The index carries the lifecycle owner. The virtual Claude path remains
    // a compatibility fallback for older indexes, but a real entry wins so a
    // future backend can use a non-file path without being mistaken for Pi.
    const indexedSession = this.sessions.find((session) => session.path === path);
    const backendKind = indexedSession?.backendKind
      ?? (claudeSessionIdFromPath(path) ? "claude-code" : undefined);
    // A thread whose runtime is already live switches immediately and outside
    // the lifecycle queue: nothing is created, aborted or replaced.
    const live = this.bridge ? undefined : this.liveThreadForPath(path);
    if (live) {
      const startedAt = performance.now();
      await this.activateThread(live, false);
      this.logReplacement("live-switch", startedAt);
      return this.activeUpdates();
    }
    return this.runLifecycle(async () => {
      const startedAt = performance.now();
      if (backendKind !== "claude-code" && this.defaultBackendKind === "pi" && await this.attachAvailableBridge(dirname(path), path)) {
        this.cwd = this.bridgeSnapshot!.cwd;
        await this.rememberProject(this.cwd);
        await this.refreshActiveThreadIndex(false);
        return this.activeUpdates();
      }
      this.detachBridge();
      const alreadyLive = this.liveThreadForPath(path);
      this.lifecycleMetrics.begin(this.safeMode ? "safe" : "full", alreadyLive ? "warm-switch" : "cold-switch");
      try {
        const thread = alreadyLive ?? await this.openThreadForPath(path, "resume", false, backendKind);
        await this.activateThread(thread, false);
        this.logReplacement("resume", startedAt);
        return this.activeUpdates();
      } finally {
        this.lifecycleMetrics.end();
      }
    });
  }

  /** Opens a thread's runtime ahead of time so switching to it is immediate. */
  async prewarmSession(path: string): Promise<void> {
    if (this.bridge || this.safeMode || this.liveThreadForPath(path)) return;
    const backendKind = this.sessions.find((session) => session.path === path)?.backendKind
      ?? (claudeSessionIdFromPath(path) ? "claude-code" : undefined);
    const startedAt = performance.now();
    try {
      await this.openThreadForPath(path, "resume", true, backendKind);
      this.log("runtime.prewarm.ready", basename(path));
    } catch (error) {
      this.log("runtime.prewarm.failed", this.errorMessage(error));
    } finally {
      this.recordBackgroundLifecycle("prewarm", startedAt);
    }
  }

  async prompt(
    text: string,
    attachments: UiPromptAttachment[] = [],
    sessionId?: string,
    clientMessageId?: string,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    if (this.bridgeOwns(sessionId)) {
      if (attachments.length > 0) throw new Error("Image attachments are not supported while Tau is attached to Pi.");
      if (prepared) this.assertBridgePreparedPrompt(text, prepared, this.bridgeSnapshot?.sessionId);
      // Pi's bridge extension is the runtime owner and performs this
      // normalization against its current command registry exactly once.
      await this.bridge!.command({ command: "prompt", text, ...(clientMessageId ? { clientMessageId } : {}), ...(prepared ? { prepared: this.piBridgePreparedPrompt(prepared) } : {}) });
      this.log("prompt.accepted", text.slice(0, 80));
      return;
    }
    const thread = this.requireThread(sessionId);
    if (!isPiBackend(thread)) {
      await this.sendThroughRuntimeAdapter(thread, text, attachments, "prompt", clientMessageId, prepared);
      return;
    }
    const session = thread.session;
    const prompt = prepared
      ? (this.assertPreparedPrompt(thread, text, prepared, this.composerCommands(thread)), prepared.runtimeText)
      : this.normalizeThreadPrompt(thread, text);
    const isExtensionCommand = this.isExtensionCommand(thread, prompt);
    let markerActive = this.appendClientMessageMarker(thread, clientMessageId, text, prepared?.sourceFingerprint);
    const wasStreaming = session.isStreaming;
    const failUnpersistedMarker = () => {
      if (!markerActive) return;
      this.failClientMessageIfUnpersisted(thread, clientMessageId);
      markerActive = false;
    };
    const images = promptImages(attachments);
    this.log("prompt.accepted", `${prompt.slice(0, 80)}${images.length ? ` · ${images.length} image(s)` : ""}`);
    try {
      await session.prompt(prompt, {
        images,
        streamingBehavior: session.isStreaming ? "followUp" : undefined,
        preflightResult: (success) => {
          if (!success) failUnpersistedMarker();
        },
      });
      // Extension commands can be handled without creating a user message or
      // an agent run. Do not leave their marker to label the next turn.
      if ((!wasStreaming || isExtensionCommand) && markerActive) failUnpersistedMarker();
      if (this.threads.get(thread.sessionId)?.runtime === thread) await this.refreshThreadShell(thread, true);
    } catch (error) {
      // A thread released mid-run reports nothing: its runtime is gone on purpose.
      if (this.threads.get(thread.sessionId)?.runtime !== thread) return;
      // A runtime can reject after accepting and even after message_start. The
      // marker stays tracked until message_end, so reconcile every failure by
      // id instead of assuming acceptance means persistence.
      failUnpersistedMarker();
      this.fail(error);
      throw error;
    }
  }

  async runShellAction(command: string, includeInContext = false, expectedCwd?: string): Promise<ShellActionResult> {
    if (this.bridge) throw new Error("Run project actions in Pi while Tau is attached to its runtime.");
    const shellCommand = command.trim();
    if (!shellCommand) throw new Error("An action command is required.");
    const thread = await this.runLifecycle(async () => {
      if (expectedCwd && this.cwd !== expectedCwd) {
        throw new Error("The selected project did not finish loading. Run the action again.");
      }
      return this.requireActive();
    });
    if (!isPiBackend(thread)) throw new Error("Project actions are unavailable for Claude Code threads; run them through the Claude runtime.");
    const session = thread.session;
    if (session.isBashRunning) throw new Error("Another project action is already running.");
    const result = await session.executeBash(shellCommand, undefined, { excludeFromContext: !includeInContext });
    if (this.threads.get(thread.sessionId)?.runtime === thread) await this.refreshThreadShell(thread, true);
    this.log("action.shell", `${result.exitCode ?? "cancelled"} · ${shellCommand}`);
    return {
      output: boundedToolOutput(result.output),
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      truncated: result.truncated,
    };
  }

  async steer(
    text: string,
    attachments: UiPromptAttachment[] = [],
    sessionId?: string,
    clientMessageId?: string,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    if (this.bridgeOwns(sessionId)) {
      if (attachments.length > 0) throw new Error("Image attachments are not supported while Tau is attached to Pi.");
      if (prepared) this.assertBridgePreparedPrompt(text, prepared, this.bridgeSnapshot?.sessionId);
      await this.bridge!.command({ command: "prompt", text, deliverAs: "steer", ...(clientMessageId ? { clientMessageId } : {}), ...(prepared ? { prepared: this.piBridgePreparedPrompt(prepared) } : {}) });
      return;
    }
    try {
      const thread = this.requireThread(sessionId);
      if (!isPiBackend(thread)) {
        await this.sendThroughRuntimeAdapter(thread, text, attachments, "steer", clientMessageId, prepared);
        return;
      }
      let markerActive = this.appendClientMessageMarker(thread, clientMessageId, text, prepared?.sourceFingerprint);
      try {
        const prompt = prepared
          ? (this.assertPreparedPrompt(thread, text, prepared, this.composerCommands(thread)), prepared.runtimeText)
          : this.normalizeThreadPrompt(thread, text);
        await thread.session.steer(prompt, promptImages(attachments));
      } catch (error) {
        if (markerActive) {
          this.failClientMessageIfUnpersisted(thread, clientMessageId);
          markerActive = false;
        }
        throw error;
      }
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async followUp(
    text: string,
    attachments: UiPromptAttachment[] = [],
    sessionId?: string,
    clientMessageId?: string,
    prepared?: PreparedPrompt,
  ): Promise<void> {
    if (this.bridgeOwns(sessionId)) {
      if (attachments.length > 0) throw new Error("Image attachments are not supported while Tau is attached to Pi.");
      if (prepared) this.assertBridgePreparedPrompt(text, prepared, this.bridgeSnapshot?.sessionId);
      await this.bridge!.command({ command: "prompt", text, deliverAs: "followUp", ...(clientMessageId ? { clientMessageId } : {}), ...(prepared ? { prepared: this.piBridgePreparedPrompt(prepared) } : {}) });
      return;
    }
    try {
      const thread = this.requireThread(sessionId);
      if (!isPiBackend(thread)) {
        await this.sendThroughRuntimeAdapter(thread, text, attachments, "followUp", clientMessageId, prepared);
        return;
      }
      let markerActive = this.appendClientMessageMarker(thread, clientMessageId, text, prepared?.sourceFingerprint);
      try {
        const prompt = prepared
          ? (this.assertPreparedPrompt(thread, text, prepared, this.composerCommands(thread)), prepared.runtimeText)
          : this.normalizeThreadPrompt(thread, text);
        await thread.session.followUp(prompt, promptImages(attachments));
      } catch (error) {
        if (markerActive) {
          this.failClientMessageIfUnpersisted(thread, clientMessageId);
          markerActive = false;
        }
        throw error;
      }
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async abort(sessionId?: string): Promise<void> {
    if (this.bridgeOwns(sessionId)) {
      await this.bridge!.command({ command: "abort" });
      return;
    }
    const thread = this.threadFor(sessionId);
    if (!thread) return;
    await this.abortThread(thread);
  }

  /**
   * Stops one thread's run. Its open questions and approvals are settled first:
   * Pi's abort waits for the run to go idle, and a tool blocked on an unanswered
   * question would otherwise hold that wait open indefinitely.
   */
  private async abortThread(thread: ThreadRuntime): Promise<void> {
    this.settleApprovalsFor(thread.sessionId, { allowed: false, reason: "Blocked by Tau: the run was stopped." });
    this.cancelUiPromptsFor(thread.sessionId);
    if (!isPiBackend(thread)) {
      thread.adapterAbortGeneration ??= 0;
      thread.adapterAbortGeneration += 1;
      for (const controller of thread.adapterAbortControllers ?? []) controller.abort();
      await thread.backend.abort();
      return;
    }
    await thread.session.abort();
  }

  async setModel(provider: string, id: string): Promise<HostActionResult> {
    if (this.bridge) {
      await this.bridge.command({ command: "set_model", provider, id });
      await this.refreshBridgeSnapshot();
      return this.catalogResult();
    }
    const thread = this.requireActive();
    if (!isPiBackend(thread)) {
      await thread.backend.setModel(provider, id);
      return this.catalogResult();
    }
    const session = thread.session;
    const model = session.modelRuntime.getModel(provider, id);
    if (!model) throw new Error(`Unknown model: ${provider}/${id}`);
    await session.setModel(model);
    this.log("model.changed", `${provider}/${id}`);
    return this.catalogResult();
  }

  async setThinkingLevel(level: string): Promise<HostActionResult> {
    if (this.bridge) {
      await this.bridge.command({ command: "set_thinking", level });
      await this.refreshBridgeSnapshot();
      return this.catalogResult();
    }
    const thread = this.requireActive();
    if (!isPiBackend(thread)) {
      await thread.backend.setThinkingLevel(level);
      return this.catalogResult();
    }
    const session = thread.session;
    if (!session.getAvailableThinkingLevels().includes(level as never)) {
      throw new Error(`Thinking level is not available: ${level}`);
    }
    session.setThinkingLevel(level as never);
    this.log("thinking.changed", level);
    return this.catalogResult();
  }

  private async catalogResult(): Promise<HostActionResult> {
    const snapshot = await this.snapshot();
    const catalog = { version: HOST_PROTOCOL_VERSION, type: "catalog" as const, catalog: catalogFromSnapshot(snapshot) };
    this.emitUpdate(catalog);
    return this.actionResult([catalog]);
  }

  async renameThread(rawTitle: string, expectedSessionId?: string): Promise<HostActionResult> {
    const title = rawTitle.trim();
    if (!title) throw new Error("Thread titles cannot be empty.");
    if (title.length > 120) throw new Error("Thread titles must be 120 characters or fewer.");
    let sessionId: string;
    let displayedTitle = title;
    if (this.bridge) {
      sessionId = this.bridgeSnapshot?.sessionId ?? "";
      if (expectedSessionId && sessionId !== expectedSessionId) {
        throw new Error("The selected thread did not finish loading. Try renaming it again.");
      }
      await this.bridge.command({ command: "set_session_name", name: title });
      await this.refreshBridgeSnapshot();
    } else {
      const thread = this.requireThread(expectedSessionId);
      sessionId = thread.sessionId;
      if (isPiBackend(thread)) {
        thread.session.setSessionName(title);
      } else {
        await thread.backend.setTitle(title, "renamed");
        const detail = await thread.backend.detail();
        thread.adapterTitle = detail.title;
        thread.adapterTitleSource = detail.titleSource;
        displayedTitle = detail.title ?? "Skill invocation";
      }
    }
    const now = Date.now();
    this.sessions = this.sessions.map((thread) =>
      thread.id === sessionId ? { ...thread, title: displayedTitle, modifiedAt: now } : thread,
    );
    const shell = this.sessions.find((thread) => thread.id === sessionId);
    if (!shell) throw new Error("The active thread is missing from the session index.");
    this.log("title.renamed", displayedTitle);
    const update: HostUpdate = {
      version: HOST_PROTOCOL_VERSION,
      type: "thread-shell",
      update: { sessionId, shell },
    };
    this.emitUpdate(update);
    return this.actionResult([update]);
  }

  async generateThreadTitle(provider: string, modelId: string, force = false, expectedSessionId?: string): Promise<HostActionResult> {
    if (this.bridge) {
      if (!force) return { version: HOST_PROTOCOL_VERSION, updates: [] };
      throw new Error("Generate the thread title in Pi while Tau is attached to its runtime.");
    }
    const thread = this.requireThread(expectedSessionId);
    if (!isPiBackend(thread)) throw new Error("Claude Code thread titles are generated by the Claude backend and cannot use Pi's model runtime.");
    const session = thread.session;
    if (session.isStreaming) {
      if (force) throw new Error("Wait for the active agent run before generating a title.");
      await session.waitForIdle();
      if (this.threads.get(thread.sessionId)?.runtime !== thread) return { version: HOST_PROTOCOL_VERSION, updates: [] };
    }
    if (session.sessionName && !force) return { version: HOST_PROTOCOL_VERSION, updates: [] };
    const model = session.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Unknown title model: ${provider}/${modelId}`);
    const persistedMessages = session.sessionManager.getBranch()
      .flatMap((entry) => entry.type === "message" ? [entry.message] : []);
    const mapping = this.messageMappingOptions(thread);
    const visibleMessages = (messages: readonly unknown[]): TitleMessage[] => messages.flatMap((message, index) => {
      const mapped = mapMessage(message, index, mapping);
      return mapped && (mapped.role === "user" || mapped.role === "assistant")
        ? [{ role: mapped.role, content: mapped.text }]
        : [];
    });
    const adapterMessages = (thread.adapterMessages ?? []).map((message) => ({ role: message.role, content: message.text }));
    const conversation = buildTitleConversation(
      [...visibleMessages(session.messages), ...adapterMessages],
      visibleMessages(persistedMessages),
    );
    if (!conversation) throw new Error("The thread has no conversation to title yet.");

    this.log("title.started", `${provider}/${modelId}`);
    const response = await session.modelRuntime.completeSimple(
      model,
      {
        systemPrompt: "Create a concise coding-thread title as one plain-text noun phrase. Use 3-7 words and at most 60 characters. Name the concrete task, change, or decision. Never use Markdown, quotes, terminal punctuation, a label, a complete sentence, or meta wording such as working on, help with, discussion about, or implementing.",
        messages: [{
          role: "user",
          content: [{
            type: "text",
            text: `Return only the plain-text title for this thread. Match the conversation's language.\n\n${conversation}`,
          }],
          timestamp: Date.now(),
        }],
      },
      {
        maxTokens: 48,
        cacheRetention: "none",
        timeoutMs: 30_000,
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error(response.errorMessage || "The title model did not complete.");
    }
    const title = cleanThreadTitle(textFromContent(response.content));
    if (this.threads.get(thread.sessionId)?.runtime !== thread) return { version: HOST_PROTOCOL_VERSION, updates: [] };
    session.setSessionName(title);
    thread.adapterTitle = title;
    thread.adapterTitleSource = "generated";
    this.sessions = this.sessions.map((entry) =>
      entry.id === session.sessionId ? { ...entry, title, modifiedAt: Date.now() } : entry,
    );
    this.log("title.generated", title);
    const update: HostUpdate = {
      version: HOST_PROTOCOL_VERSION,
      type: "thread-shell",
      update: { sessionId: session.sessionId, shell: this.sessions.find((entry) => entry.id === session.sessionId) },
    };
    this.emitUpdate(update);
    return this.actionResult([update]);
  }

  setAccessLevel(level: AccessLevel): { applied: boolean; reason?: string } {
    if (this.bridge) {
      return { applied: false, reason: "Access controls stay with Pi while it owns this runtime." };
    }
    if (level === this.accessLevel) return { applied: true };
    this.accessLevel = level;
    this.log("access.level", level);
    // Anything already waiting was queued under the previous rules; let it through
    // only if the new level does not require asking.
    if (level === "full") this.settleAllApprovals({ allowed: true });
    if (level === "read-only") {
      this.settleAllApprovals({ allowed: false, reason: "Blocked by Tau: switched to read-only." });
    }
    return { applied: true };
  }

  resolveToolApproval(id: string, allowed: boolean): void {
    this.pendingApprovals.get(id)?.settle({
      allowed,
      reason: allowed ? undefined : "Blocked by Tau: you declined this tool call.",
    });
    this.pendingApprovals.delete(id);
  }

  async setServiceTier(tier: ServiceTier): Promise<HostActionResult> {
    this.serviceTier = tier;
    this.serviceTierReported.clear();
    this.log("service-tier.changed", tier);
    return this.catalogResult();
  }

  /** The active model's API decides whether a priority tier can be asked for at all. */
  private serviceTierAvailable(): boolean {
    const api = (this.runtime?.session.model as { api?: string } | undefined)?.api;
    return Boolean(api && SERVICE_TIER_APIS.has(api));
  }

  async reloadRuntime(): Promise<void> {
    return this.runLifecycle(async () => {
      if (this.bridge) {
        await this.bridge.command({ command: "reload" });
        this.log("runtime.reload.requested", "Pi owner");
        return;
      }
      const thread = this.requireActive();
      if (!isPiBackend(thread)) throw new Error("Claude Code runtime resources are managed by the Claude backend and cannot be reloaded as Pi extensions.");
      if (thread.session.isStreaming) throw new Error("Wait for the active run before reloading Pi.");
      await thread.session.reload();
      this.modelCatalogCache.invalidate();
      this.resourceDiscoveryCache.invalidate();
      // Other idle runtimes still hold the old resources; they are cheap to
      // rebuild on demand, so drop them rather than reload each one.
      this.discardSpare();
      for (const record of this.threads.list()) {
        if (record.runtime !== thread && isPiBackend(record.runtime)
          && record.runtime.session.isIdle && !this.hasOpenUiPrompts(record.sessionId)) {
          await this.threads.release(record.sessionId);
        }
      }
      this.extensionCount = thread.session.resourceLoader.getExtensions().extensions.length;
      this.log("runtime.reloaded");
      const snapshot = await this.snapshot();
      for (const update of this.lifecycleUpdates(snapshot)) this.emitUpdate(update);
      this.scheduleRuntimePrewarm();
      this.scheduleSpareThread(this.cwd);
    });
  }

  async compactContext(): Promise<HostActionResult> {
    if (this.bridge) {
      await this.bridge.command({ command: "compact" }, 120_000);
      await this.refreshBridgeSnapshot();
    } else {
      await this.requireActive().backend.compact();
    }
    this.log("context.compacted");
    const snapshot = await this.snapshot();
    const update: HostUpdate = { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) };
    this.emitUpdate(update);
    return this.actionResult([update]);
  }

  async snapshot(): Promise<HostSnapshot> {
    const models = await this.ensureModels();
    return { ...this.snapshotSync(models), branch: this.branchFor(this.cwd) };
  }

  async getFileTree(path?: string): Promise<FileNode[]> {
    const root = path ?? this.cwd;
    await assertWorkspacePath(this.cwd, root);
    return this.readTree(root, 0, { count: 0 });
  }

  async getChanges(): Promise<UiWorkspaceChanges> {
    return this.gitCoordinator.getChanges(this.cwd);
  }

  async getFileDiff(path: string, options?: DiffLoadOptions): Promise<UiFileDiff> {
    await assertWorkspacePath(this.cwd, path);
    return workspaceGit.getFileDiff(this.cwd, path, options);
  }

  async commit(message: string, push: boolean): Promise<CommitResult> {
    const project = this.cwd;
    try {
      const result = await workspaceGit.commit(project, message, push, async (cwd) => {
        this.gitCoordinator.invalidate(cwd);
        return this.gitCoordinator.getChanges(cwd);
      });
      this.gitCoordinator.invalidate(project);
      this.log("git.commit", result.detail);
      return result;
    } catch (error) {
      this.gitCoordinator.invalidate(project);
      throw error;
    }
  }

  async getWorkspaceInfo(): Promise<WorkspaceInfo> {
    return this.gitCoordinator.getWorkspaceInfo(this.cwd);
  }

  async push(): Promise<PushResult> {
    const project = this.cwd;
    try {
      const result = await workspaceGit.push(project);
      this.gitCoordinator.invalidate(project);
      this.log("git.push", result.detail);
      return result;
    } catch (error) {
      this.gitCoordinator.invalidate(project);
      throw error;
    }
  }

  async createWorktree(branch: string, baseRef?: string): Promise<HostActionResult> {
    return this.runLifecycle(async () => {
      const project = this.cwd;
      try {
        const destination = await workspaceGit.createWorktree(
          project,
          branch,
          baseRef,
          (cwd) => this.gitCoordinator.getWorkspaceInfo(cwd),
        );
        this.knownProjectNames.set(destination, await this.loadProjectName(project));
        this.gitCoordinator.invalidate(project, ["branch", "status", "workspace"]);
        this.log("git.worktree.added", destination);
        return this.setWorkspaceNow(destination);
      } catch (error) {
        this.gitCoordinator.invalidate(project, ["branch", "status", "workspace"]);
        throw error;
      }
    });
  }

  async switchRef(ref: string): Promise<HostActionResult> {
    return this.runLifecycle(async () => {
      const project = this.cwd;
      try {
        const target = await workspaceGit.resolveRefTarget(project, ref, (cwd) => this.gitCoordinator.getWorkspaceInfo(cwd));
        this.log("git.ref.switch", `${ref} → ${target}`);
        this.gitCoordinator.invalidate(project, ["branch", "status", "workspace"]);
        if (target === this.cwd) return this.activeUpdates();
        return this.setWorkspaceNow(target);
      } catch (error) {
        this.gitCoordinator.invalidate(project, ["branch", "status", "workspace"]);
        throw error;
      }
    });
  }

  async listEditors(): Promise<UiEditor[]> {
    return workspaceGit.listEditors();
  }

  async openInEditor(editorId: string, path?: string): Promise<void> {
    if (path) await assertWorkspacePath(this.cwd, path);
    await workspaceGit.openInEditor(this.cwd, editorId, path);
  }

  async dispose(): Promise<void> {
    return this.runLifecycle(async () => {
      this.toolOutputBatcher.dispose();
      if (this.activeIndexPublish) clearTimeout(this.activeIndexPublish);
      this.activeIndexPublish = undefined;
      if (this.indexRecoveryTimer) clearInterval(this.indexRecoveryTimer);
      this.indexRecoveryTimer = undefined;
      if (this.prewarmTimer) clearTimeout(this.prewarmTimer);
      this.prewarmTimer = undefined;
      this.pendingShellUpdates.clear();
      const teardownErrors: unknown[] = [];
      this.detachBridge();
      try { await this.discardSpare(); } catch (error) { teardownErrors.push(error); }
      const opening = [...this.openingThreads.values()];
      this.openingThreads.clear();
      await Promise.allSettled(opening);
      const results = await Promise.allSettled(this.threads.list().map((record) => this.threads.release(record.sessionId)));
      for (const result of results) if (result.status === "rejected") teardownErrors.push(result.reason);
      try {
        await this.projectHistory.flush();
      } catch (error) {
        teardownErrors.push(error);
      }
      if (teardownErrors.length > 0) {
        throw new AggregateError(teardownErrors, "Pi runtime shutdown failed");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Thread runtime lifecycle
  // ---------------------------------------------------------------------------

  /** Opens a Claude-owned thread without allocating a Pi AgentSession carrier. */
  private async openClaudeThread(
    sessionId: string,
    cwd: string,
    options: { background?: boolean; adopt?: boolean; resume?: boolean } = {},
  ): Promise<ThreadRuntime> {
    if (this.safeMode) throw new Error("Claude Code threads are disabled in Tau safe mode; choose the Pi runtime.");
    const adapter = this.adapterFor("claude-code");
    if (adapter.id !== "claude-code") throw new Error("Claude Code is not configured for this host.");
    const store = this.claudeSessionStore();
    if (!store) throw new Error("Claude Code backend has no durable session store.");
    const backend = new ClaudeThreadRuntimeBackend(sessionId, cwd, {
      adapter,
      store,
      commands: () => this.claudeComposerCommands(cwd),
      projectName: this.projectNameFor(cwd),
      branch: this.knownBranches.get(cwd),
      permissionPolicy: () => runtimePermissionPolicy(this.accessLevel),
      onMessage: (message) => {
        const thread = this.threads.get(sessionId)?.runtime;
        if (thread) {
          thread.adapterMessages = [...thread.adapterMessages, message];
          this.emit(message.role === "user"
            ? { type: "user-message", sessionId, message }
            : { type: "assistant-end", sessionId, message });
        }
      },
    });
    if (options.resume === false) await backend.create();
    else await backend.resume();
    const thread = new ThreadRuntime(backend);
    thread.adapterMessages = await backend.transcript();
    thread.adapterTitle = (await store.get(sessionId))?.title;
    thread.adapterTitleSource = (await store.get(sessionId))?.titleSource;
    if (options.adopt !== false) await this.adoptThread(thread);
    return thread;
  }

  /**
   * Builds a runtime for one session, binds Tau's UI to it, and hands it to the
   * registry. The thread is live afterwards but not yet on screen.
   */
  private async openThread(
    manager: SessionManager,
    sessionStartEvent: RuntimeStartEvent | undefined,
    options: { background?: boolean; adopt?: boolean } = {},
  ): Promise<ThreadRuntime> {
    const cwd = manager.getCwd() || this.cwd;
    if (options.background) this.backgroundManagers.add(manager);
    let runtime: AgentSessionRuntime | undefined;
    try {
      const createdRuntime = await createAgentSessionRuntime(this.createRuntime, {
        cwd,
        agentDir: this.agentDir,
        sessionManager: manager,
        sessionStartEvent,
      });
      let thread!: ThreadRuntime;
      runtime = createdRuntime;
      const backend = new PiThreadRuntimeBackend(createdRuntime, this.adapterFor("pi"), {
        commands: () => this.composerCommands(thread),
        mapMessages: (messages) => messages
          .map((message, index) => mapMessage(message, index, this.messageMappingOptions(thread)))
          .filter((message): message is UiMessage => Boolean(message?.text || message?.skill)),
        index: async () => this.sessions.find((entry) => entry.id === createdRuntime.session.sessionId) ?? {
          id: createdRuntime.session.sessionId,
          path: createdRuntime.session.sessionFile ?? createdRuntime.session.sessionId,
          title: cleanThreadTitle(safeSessionTitle(createdRuntime.session.sessionName) || firstSentence(visibleTitleText(textFromContent((createdRuntime.session.messages[0] as { content?: unknown } | undefined)?.content)))),
          modifiedAt: Date.now(),
          projectPath: createdRuntime.cwd,
          projectName: this.projectNameFor(createdRuntime.cwd),
          branch: this.branchFor(createdRuntime.cwd),
          messageCount: createdRuntime.session.messages.length,
          backendKind: "pi",
        },
      });
      thread = new ThreadRuntime(backend, createdRuntime);
      if (sessionStartEvent?.reason === "resume") await backend.resume();
      else await backend.create();
      await this.bindThread(thread, thread.session);
      this.installThreadHooks(thread);
      if (options.adopt !== false) await this.adoptThread(thread);
      return thread;
    } catch (error) {
      if (runtime) {
        const cleanupErrors = await this.teardownRuntime(runtime, true);
        if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "Pi runtime initialization failed");
      }
      throw error;
    } finally {
      this.backgroundManagers.delete(manager);
    }
  }

  private async adoptThread(thread: ThreadRuntime): Promise<void> {
    await this.threads.adopt({ sessionId: thread.sessionId, cwd: thread.cwd, runtime: thread, isolation: "in-process" });
  }

  /** One runtime per session file: concurrent opens for the same path share it. */
  private openThreadForPath(
    path: string,
    reason: "resume",
    background = false,
    backendKind?: ThreadBackendKind,
  ): Promise<ThreadRuntime> {
    const live = this.liveThreadForPath(path);
    if (live) return Promise.resolve(live);
    let pending = this.openingThreads.get(path);
    if (!pending) {
      pending = (async () => {
        const storedSessionId = claudeSessionIdFromPath(path);
        const indexedSession = this.sessions.find((session) => session.path === path);
        const owner = backendKind ?? indexedSession?.backendKind ?? (storedSessionId ? "claude-code" : "pi");
        if (owner === "claude-code") {
          if (this.safeMode) throw new Error("Claude Code threads are disabled in Tau safe mode; choose the Pi runtime.");
          const sessionId = storedSessionId ?? indexedSession?.id;
          if (!sessionId) throw new Error("The Claude Code session has no durable session id.");
          const record = await this.claudeSessionStore()?.get(sessionId);
          if (!record) throw new Error("The selected Claude Code session is no longer available.");
          return this.openClaudeThread(record.tauSessionId, record.cwd, { background });
        }
        if (storedSessionId) throw new Error("The selected Claude Code session is owned by another runtime backend.");
        let manager: SessionManager;
        manager = SessionManager.open(path);
        return this.openThread(
          manager,
          { type: "session_start", reason, previousSessionFile: this.active?.sessionFile },
          { background },
        );
      })().then((thread) => thread).finally(() => {
        if (this.openingThreads.get(path) === pending) this.openingThreads.delete(path);
      });
      this.openingThreads.set(path, pending);
    }
    return pending;
  }

  private async bindThread(thread: ThreadRuntime, session: AgentSession): Promise<void> {
    if (thread.runtime?.session !== session) throw new Error("Cannot bind a stale Pi session");
    const bindStartedAt = performance.now();
    await session.bindExtensions({
      uiContext: createExtensionUiContext({
        sessionId: () => thread.sessionId,
        ask: (prompt) => this.askExtensionUi(prompt),
        notify: (message, level) => this.emit({ type: "notice", message, level }),
        setWindowTitle: (title) => this.onWindowTitle?.(title),
        unsupported: (method) => this.log("extension-ui.unsupported", method),
      }),
      mode: "rpc",
      onError: (error) => this.fail(error),
    });
    this.recoverOrphanedClientMessageMarkers(thread);
    this.logRuntimePhase("bind", bindStartedAt, "active", thread.cwd);
    thread.unsubscribe?.();
    thread.unsubscribe = session.subscribe((event) => this.handleSessionEvent(event, thread, thread.sessionId, thread.cwd));
  }

  /**
   * A persisted request marker can outlive a host process that crashed or was
   * disconnected before Pi emitted the corresponding user message. Cancel
   * those markers before subscribing to a reopened runtime so they cannot be
   * assigned to a later, unrelated turn.
   */
  private recoverOrphanedClientMessageMarkers(thread: ThreadRuntime): void {
    const manager = thread.session.sessionManager;
    const staleIds = unclaimedClientMessageIds(manager.getBranch(), knownSkillNames(this.composerCommands(thread)));
    for (const clientMessageId of staleIds) {
      manager.appendCustomEntry(CLIENT_MESSAGE_CANCEL_MARKER, clientMessageCancelMarker(clientMessageId).data);
      this.forgetClientMessageId(thread, clientMessageId);
    }
  }

  private installThreadHooks(thread: ThreadRuntime): void {
    const runtime = thread.runtime;
    if (!runtime) return;
    runtime.setBeforeSessionInvalidate(() => {
      thread.unsubscribe?.();
      thread.unsubscribe = undefined;
      thread.resetLiveState();
    });
    runtime.setRebindSession(async (session) => {
      await this.bindThread(thread, session);
      if (this.active === thread) await this.publishActiveCatalog();
    });
  }

  /** Puts a live thread on screen. Cheap: it changes pointers and publishes state. */
  private async activateThread(thread: ThreadRuntime, touch: boolean): Promise<void> {
    if (!this.threads.has(thread.sessionId)) await this.adoptThread(thread);
    this.threads.setActive(thread.sessionId);
    this.cwd = thread.cwd;
    this.extensionCount = isPiBackend(thread) ? thread.session.resourceLoader.getExtensions().extensions.length : 0;
    await this.rememberProject(this.cwd);
    await this.refreshThreadShell(thread, touch);
    this.log("session.opened", thread.sessionId.slice(0, 8));
    this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd: thread.cwd } });
    this.scheduleRuntimePrewarm();
    if (this.defaultBackendKind === "pi") this.scheduleSpareThread(thread.cwd);
  }

  private async publishActiveCatalog(): Promise<void> {
    const snapshot = await this.snapshot();
    this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) });
  }

  private async disposeThread(thread: ThreadRuntime): Promise<void> {
    this.settleApprovalsFor(thread.sessionId, { allowed: false, reason: "Blocked by Tau: the thread was closed." });
    this.cancelUiPromptsFor(thread.sessionId);
    thread.adapterAbortGeneration ??= 0;
    thread.adapterAbortGeneration += 1;
    if (!isPiBackend(thread)) {
      try {
        for (const controller of thread.adapterAbortControllers ?? []) controller.abort();
        await thread.backend.abort();
      } catch (error) {
        this.log("runtime.adapter.abort-failed", this.errorMessage(error));
      }
    }
    thread.unsubscribe?.();
    thread.unsubscribe = undefined;
    for (const id of thread.tools.keys()) this.toolOwners.delete(id);
    const errors = thread.backend && !isPiBackend(thread)
      ? await (async () => { try { await thread.backend.dispose(); return []; } catch (error) { return [error]; } })()
      : thread.runtime ? await this.teardownRuntime(thread.runtime, true) : [];
    if (errors.length > 0) throw new AggregateError(errors, "Pi runtime shutdown failed");
  }

  private async teardownRuntime(runtime: AgentSessionRuntime, abortSession = true): Promise<unknown[]> {
    const errors: unknown[] = [];
    if (abortSession) {
      try {
        // A run that will not stop must not block shutdown forever.
        await Promise.race([
          runtime.session.abort(),
          new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_ABORT_MS).unref?.()),
        ]);
      } catch (error) {
        errors.push(error);
      }
    }
    let disposed = false;
    try {
      await runtime.dispose();
      disposed = true;
    } catch (error) {
      errors.push(error);
    }
    if (!disposed) {
      try {
        runtime.session.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  private scheduleSpareThread(cwd: string): void {
    if (!this.automaticPrewarm || this.safeMode || this.spare?.cwd === cwd) return;
    void this.discardSpare().catch((error) => this.fail(error));
    const startedAt = performance.now();
    const pending = this.openThread(
      SessionManager.create(cwd),
      { type: "session_start", reason: "new", previousSessionFile: undefined },
      { background: true, adopt: false },
    ).then((thread) => {
      this.log("runtime.spare.ready", basename(cwd));
      return thread;
    }).catch((error) => {
      this.log("runtime.spare.failed", this.errorMessage(error));
      return undefined;
    }).finally(() => this.recordBackgroundLifecycle("spare", startedAt));
    this.spare = { cwd, pending };
  }

  private async takeSpareThread(cwd: string): Promise<ThreadRuntime | undefined> {
    const spare = this.spare;
    if (!spare || spare.cwd !== cwd) return undefined;
    this.spare = undefined;
    const thread = await spare.pending;
    if (!thread) return undefined;
    await this.adoptThread(thread);
    return thread;
  }

  private async discardSpare(): Promise<void> {
    const spare = this.spare;
    this.spare = undefined;
    if (!spare) return;
    const thread = await spare.pending;
    if (thread) await this.disposeThread(thread);
  }

  private projectNameFor(cwd: string): string {
    return this.knownProjectNames.get(cwd) ?? (basename(cwd) || cwd);
  }

  private async loadProjectName(cwd: string): Promise<string> {
    const known = this.knownProjectNames.get(cwd);
    if (known) return known;
    const name = await workspaceGit.repositoryDisplayName(cwd);
    this.knownProjectNames.set(cwd, name);
    return name;
  }

  private async rememberProject(cwd: string): Promise<void> {
    await this.projectHistory.remember(cwd, await this.loadProjectName(cwd));
  }

  /**
   * The branch a project is on, as last seen. A refresh always runs in the
   * background and publishes when the answer changes, so opening or switching a
   * thread never waits on git — a busy repository used to hold switches for
   * seconds behind its own status scan.
   */
  private branchFor(cwd: string): string | undefined {
    this.refreshBranchInBackground(cwd);
    return this.knownBranches.get(cwd);
  }

  private refreshBranchInBackground(cwd: string): void {
    if (this.branchRefreshes.has(cwd)) return;
    const startedAt = performance.now();
    const pending = this.resolveBranch(cwd).then((branch) => {
      const known = this.knownBranches.has(cwd);
      const previous = this.knownBranches.get(cwd);
      this.knownBranches.set(cwd, branch);
      if (!known || previous !== branch) this.publishBranch(cwd, branch);
    }).catch((error) => this.log("branch.failed", `${basename(cwd)}: ${this.errorMessage(error)}`)).finally(() => {
      this.recordBackgroundLifecycle("branch", startedAt);
      this.branchRefreshes.delete(cwd);
    });
    this.branchRefreshes.set(cwd, pending);
  }

  private publishBranch(cwd: string, branch: string | undefined): void {
    if (cwd === this.cwd) {
      this.projectBranch = branch;
      this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd, branch } });
    }
    const changed = this.sessions.filter((session) => session.projectPath === cwd && session.branch !== branch);
    if (changed.length === 0) return;
    this.sessions = this.sessions.map((session) => session.projectPath === cwd ? { ...session, branch } : session);
    for (const session of this.sessions) {
      if (session.projectPath === cwd) this.publishThreadShellSoon(session);
    }
  }

  private recordBackgroundLifecycle(name: string, startedAt: number): void {
    this.backgroundLifecycle.push({ name, durationMs: Math.round((performance.now() - startedAt) * 10) / 10 });
    if (this.backgroundLifecycle.length > 100) this.backgroundLifecycle.shift();
  }

  private scheduleRuntimePrewarm(): void {
    if (!this.automaticPrewarm || this.safeMode || this.prewarmTimer) return;
    this.prewarmTimer = setTimeout(() => {
      this.prewarmTimer = undefined;
      if (this.bridge) return;
      const live = this.liveSessionIds();
      const candidates = this.sessions
        .filter((session) => session.projectPath === this.cwd && !live.has(session.id) && !this.openingThreads.has(session.path))
        .slice(0, Math.max(0, MAX_LIVE_THREADS - 2 - live.size));
      for (const session of candidates) void this.prewarmSession(session.path);
    }, 1_000);
    this.prewarmTimer.unref?.();
  }

  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation);
    this.lifecycleQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Pi session bridge (a Pi TUI owns the visible thread)
  // ---------------------------------------------------------------------------

  private async attachAvailableBridge(
    cwd: string,
    sessionFile?: string,
    options: { ownerPid?: number } = {},
  ): Promise<boolean> {
    if (this.safeMode || this.suppressBridgeAttach) return false;
    const descriptor = await findPiBridge(cwd, sessionFile, options.ownerPid);
    if (!descriptor) return false;
    if (this.bridge?.descriptor.epoch === descriptor.epoch && this.bridge.isConnected) return true;
    const client = new PiBridgeClient(descriptor);
    let bridgeSnapshot: PiBridgeSnapshot;
    try {
      bridgeSnapshot = await client.open();
    } catch (error) {
      client.close();
      this.log("bridge.connect.failed", this.errorMessage(error));
      if (!processIsAlive(descriptor.pid)) return false;
      throw new Error(`Pi owns this session, but Tau could not connect to it: ${this.errorMessage(error)}`);
    }
    if (bridgeSnapshot.runtimeCapabilities
      && bridgeSnapshot.runtimeCapabilities.skillInvocationDialect !== PI_AGENT_RUNTIME_ADAPTER.capabilities.skillInvocationDialect) {
      client.close();
      throw new Error("The attached bridge does not advertise the Pi runtime adapter.");
    }
    for (const clientMessageId of bridgeSnapshot.failedClientMessageIds ?? []) {
      if (typeof clientMessageId === "string" && clientMessageId.length > 0) {
        this.emit({
          type: "user-message-failed",
          sessionId: bridgeSnapshot.sessionId,
          clientMessageId,
          message: "Pi did not add the prompt to the transcript.",
        });
      }
    }
    // Pi is the sole writer of that session while attached; a local runtime for
    // the same file would race it.
    const local = this.liveThreadForPath(descriptor.sessionFile);
    if (local) await this.threads.release(local.sessionId);
    this.threads.setActive(undefined);
    this.detachBridge(false);
    this.bridge = client;
    this.bridgeSnapshot = bridgeSnapshot;
    this.cwd = bridgeSnapshot.cwd;
    const unsubscribeEvents = client.subscribe((frame) => this.handleBridgeFrame(frame));
    const unsubscribeDisconnect = client.subscribeDisconnect(() => {
      if (this.bridge === client) this.reconnectBridge(client);
    });
    this.bridgeUnsubscribe = () => { unsubscribeEvents(); unsubscribeDisconnect(); };
    this.log("bridge.attached", bridgeSnapshot.sessionId.slice(0, 8));
    return true;
  }

  private detachBridge(cancelReconnect = true): void {
    if (cancelReconnect) this.bridgeReconnectLoop.cancel();
    if (!this.bridge) return;
    // Pi's run state was ours only while attached; leaving it set would keep the
    // thread looking busy forever once Tau is no longer following that session.
    const detachedSessionId = this.bridgeSnapshot?.sessionId;
    if (detachedSessionId) {
      this.emit({ type: "agent-status", sessionId: detachedSessionId, running: false });
    }
    this.syncBridgeAwaitingInput({ ...(this.bridgeSnapshot ?? {}), awaitingInput: undefined } as PiBridgeSnapshot);
    this.bridgeUnsubscribe?.();
    this.bridgeUnsubscribe = undefined;
    this.bridge.close();
    this.bridge = undefined;
    this.bridgeSnapshot = undefined;
  }

  private reconnectBridge(disconnected: PiBridgeClient): void {
    const { cwd, sessionFile, pid } = disconnected.descriptor;
    this.emit({ type: "event-log", label: "bridge.reconnecting", detail: "Pi session bridge", timestamp: Date.now() });
    this.bridgeReconnectLoop.start(
      async () => {
        if (await this.attachAvailableBridge(cwd, sessionFile)) return true;
        return this.attachAvailableBridge(cwd, undefined, { ownerPid: pid });
      },
      () => {
        void this.refreshActiveThreadIndex(false).then(async () => {
          const snapshot = await this.snapshot();
          for (const update of this.lifecycleUpdates(snapshot)) this.emitUpdate(update);
          this.emit({ type: "event-log", label: "bridge.reconnected", detail: "Pi session bridge", timestamp: Date.now() });
        }).catch((error) => this.fail(error));
      },
      (error) => this.log("bridge.reconnect.retry", this.errorMessage(error)),
    );
  }

  private handleBridgeFrame(frame: PiBridgeServerFrame): void {
    if (frame.type === "event") {
      this.handleBridgeSessionEvent(frame.event, frame.sessionId);
      return;
    }
    if (frame.type !== "snapshot") return;
    this.bridgeSnapshot = frame.snapshot;
    this.syncBridgeAwaitingInput(frame.snapshot);
    this.cwd = frame.snapshot.cwd;
    void this.snapshot().then((snapshot) => {
      this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) });
      this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) });
    }).catch((error) => this.fail(error));
  }

  /**
   * Pi answers its own extension questions in its terminal, so Tau cannot offer
   * the choices. It can still stop the thread from looking like ordinary work and
   * say where the answer is expected.
   */
  private bridgeAwaitingPromptId?: string;

  private syncBridgeAwaitingInput(snapshot: PiBridgeSnapshot): void {
    const awaiting = snapshot.awaitingInput;
    if (awaiting && !this.bridgeAwaitingPromptId) {
      const id = `bridge-await-${snapshot.sessionId}`;
      this.bridgeAwaitingPromptId = id;
      this.emit({
        type: "extension-ui-prompt",
        prompt: {
          id,
          sessionId: snapshot.sessionId,
          kind: awaiting.kind,
          title: awaiting.title ?? "Pi is waiting for an answer",
          message: "This thread runs in Pi, which asks in its own terminal. Answer it there to continue.",
          answerElsewhere: true,
        },
      });
      return;
    }
    if (!awaiting && this.bridgeAwaitingPromptId) {
      this.emit({ type: "extension-ui-resolved", id: this.bridgeAwaitingPromptId });
      this.bridgeAwaitingPromptId = undefined;
    }
  }

  private async refreshBridgeSnapshot(): Promise<void> {
    if (!this.bridge) return;
    this.bridgeSnapshot = await this.bridge.command({ command: "snapshot" }) as PiBridgeSnapshot;
  }

  private bridgeHostSnapshot(): HostSnapshot {
    const snapshot = this.bridgeSnapshot;
    if (!snapshot) throw new Error("Pi bridge snapshot is unavailable.");
    const mapping = this.messageMappingOptions();
    const runtimeAdapter = this.bridgeRuntimeAdapter();
    const composerCommands = this.composerCommandsForAdapter(snapshot.composerCommands ?? [], runtimeAdapter);
    const messages = snapshot.messages
      .map((message, index) => mapMessage(message, index, mapping))
      .filter((message): message is UiMessage => Boolean(message?.text || message?.skill));
    const firstUserMessage = messages.find((message) => message.role === "user");
    const taskHistory = mergeTaskProgressHistory(
      snapshot.taskHistory,
      taskProgressHistoryFromMessages(snapshot.messages),
    );
    return {
      cwd: snapshot.cwd,
      sessionId: snapshot.sessionId,
      sessionName: safeSessionTitle(snapshot.sessionName),
      sessionTitle: cleanThreadTitle(safeSessionTitle(snapshot.sessionName) || firstSentence(visibleTitleText(firstUserMessage?.text ?? ""))),
      model: snapshot.model ? mapModel(snapshot.model) : undefined,
      runtimeCapabilities: snapshot.runtimeCapabilities ?? PI_AGENT_RUNTIME_ADAPTER.capabilities,
      backendKind: "pi",
      models: snapshot.models.map(mapModel),
      thinkingLevel: snapshot.thinkingLevel,
      thinkingLevels: snapshot.thinkingLevels,
      messages,
      isStreaming: snapshot.isStreaming,
      activeTools: snapshot.activeTools,
      turnActivity: lastTurnActivityFromMessages(snapshot.messages),
      taskProgress: snapshot.taskProgress ?? taskProgressFromMessages(snapshot.messages),
      taskHistory,
      allTools: snapshot.allTools,
      composerCommands,
      extensionCount: 0,
      serviceTier: "standard",
      serviceTierAvailable: false,
      contextUsage: snapshot.contextUsage && snapshot.contextUsage.tokens !== null && snapshot.contextUsage.percent !== null
        ? { tokens: snapshot.contextUsage.tokens, contextWindow: snapshot.contextUsage.contextWindow, percent: snapshot.contextUsage.percent }
        : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Session events. Every live runtime reports through here; the thread it
  // belongs to travels with each event so the renderer can scope it.
  // ---------------------------------------------------------------------------

  /** Bridge events have no local runtime; a detached carrier keeps their live state. */
  private bridgeTurn?: LiveTurnState & { sessionId: string };

  private handleBridgeSessionEvent(event: any, sessionId: string): void {
    if (this.bridgeTurn?.sessionId !== sessionId) this.bridgeTurn = { sessionId, tools: new Map() };
    this.handleSessionEvent(event, this.bridgeTurn, sessionId, this.cwd);
  }

  private handleSessionEvent(event: any, thread: LiveTurnState, sessionId: string, cwd: string): void {
      switch (event.type) {
        case "user_message_failed":
          if (typeof event.clientMessageId === "string") {
            this.emit({
              type: "user-message-failed",
              sessionId,
              clientMessageId: event.clientMessageId,
              message: typeof event.message === "string" ? event.message : "Pi rejected the message.",
            });
          }
          break;
        case "agent_start":
          this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "run", event: "started", sessionId });
          this.emit({ type: "agent-status", sessionId, running: true });
          this.log("agent.started", sessionId.slice(0, 8));
          break;
        case "agent_end":
          this.log("agent.ended", `${event.messages.length} messages`);
          break;
        case "agent_settled":
          // Pi can report a settled inner turn while a follow-up is already
          // queued. Only an actually idle session proves that no pending
          // marker still belongs to a subsequent queued user message.
        if (isThreadRuntime(thread) && thread.session.isIdle
          && (thread.pendingClientMessageIds.length > 0 || thread.inFlightClientMessageIds.size > 0)) {
            for (const clientMessageId of this.trackedClientMessageIds(thread)) {
              this.failClientMessageIfUnpersisted(thread, clientMessageId, sessionId);
            }
            // Every tracked id was either persisted or canceled above.
            thread.pendingClientMessageIds.length = 0;
            thread.inFlightClientMessageIds.clear();
          }
          this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "run", event: "settled", sessionId });
          this.emit({ type: "agent-status", sessionId, running: false });
          this.log("agent.settled", sessionId.slice(0, 8));
          break;
        case "message_start":
          if (event.message.role === "user" && isThreadRuntime(thread)) {
            this.correlateUserMessageStart(thread, event.message);
          }
          if (event.message.role === "assistant") {
            thread.currentAssistantId = `assistant-live-${event.message.timestamp}`;
            thread.liveAssistant = { id: thread.currentAssistantId, text: "", thinking: "", timestamp: event.message.timestamp };
            this.emit({
              type: "assistant-start",
              sessionId,
              id: thread.currentAssistantId,
              timestamp: event.message.timestamp,
            });
          }
          break;
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (!thread.currentAssistantId) break;
          if (update.type === "text_delta") {
            if (thread.liveAssistant) thread.liveAssistant.text += update.delta;
            this.emit({ type: "assistant-delta", sessionId, id: thread.currentAssistantId, delta: update.delta });
          } else if (update.type === "thinking_delta") {
            if (thread.liveAssistant) thread.liveAssistant.thinking += update.delta;
            this.emit({ type: "assistant-thinking", sessionId, id: thread.currentAssistantId, delta: update.delta });
          }
          break;
        }
        case "message_end":
          if (event.message.role === "assistant") {
            const message = mapMessage(event.message, 0, this.messageMappingOptions(thread));
            if (message) {
              message.id = thread.currentAssistantId ?? message.id;
              this.emit({ type: "assistant-end", sessionId, message });
            }
            thread.currentAssistantId = undefined;
            thread.liveAssistant = undefined;
          } else if (event.message.role === "user") {
            const decorated = isThreadRuntime(thread) ? this.decorateUserEvent(thread, event.message) : event.message;
            const message = mapMessage(decorated, 0, this.messageMappingOptions(thread));
            if (message) this.emit({ type: "user-message", sessionId, message });
          }
          break;
        case "tool_execution_start": {
          const tool: UiToolRun = {
            id: event.toolCallId,
            name: event.toolName,
            args: event.args as Record<string, unknown>,
            status: "running",
            startedAt: Date.now(),
          };
          thread.tools.set(tool.id, tool);
          this.toolOwners.set(tool.id, sessionId);
          this.emit({ type: "tool-start", sessionId, tool });
          this.log("tool.started", event.toolName);
          break;
        }
        case "tool_execution_update": {
          const output = boundedToolOutput(resultText(event.partialResult));
          const previous = thread.tools.get(event.toolCallId);
          if (previous) thread.tools.set(event.toolCallId, { ...previous, output });
          this.toolOutputBatcher.push(event.toolCallId, output);
          break;
        }
        case "tool_execution_end": {
          // Never let a delayed batch arrive after the terminal event.
          this.toolOutputBatcher.flushId(event.toolCallId);
          const previous = thread.tools.get(event.toolCallId);
          const tool: UiToolRun = {
            id: event.toolCallId,
            name: event.toolName,
            args: (previous?.args ?? {}) as Record<string, unknown>,
            status: event.isError ? "error" : "done",
            output: boundedToolOutput(resultText(event.result)),
            startedAt: previous?.startedAt ?? Date.now(),
            endedAt: Date.now(),
          };
          this.invalidateGitAfterTool(tool, cwd);
          this.emit({ type: "tool-end", sessionId, tool });
          // Settled output belongs to the renderer/artifact store, not the host's
          // active-run map. Do not retain every completed tool forever.
          thread.tools.delete(tool.id);
          this.toolOwners.delete(tool.id);
          this.log("tool.ended", `${event.toolName}:${tool.status}`);
          break;
        }
        case "queue_update":
          this.emit({ type: "queue", sessionId, steering: [...event.steering], followUp: [...event.followUp] });
          break;
      }
  }

  private async ensureModels(): Promise<UiModel[]> {
    if (this.bridgeSnapshot) return this.bridgeSnapshot.models.map(mapModel);
    if (this.active && !isPiBackend(this.active)) return [];
    const key = this.resourceFingerprint(this.cwd);
    const cached = this.modelCatalogCache.get(key);
    if (cached) return cached;
    const models = (await this.requireSession().modelRuntime.getAvailable()).map(mapModel);
    this.modelCatalogCache.set(key, models);
    return models;
  }

  private resourceFingerprint(cwd: string, settingsManager?: SettingsManager): string {
    return runtimeResourceFingerprint({
      cwd,
      settings: settingsManager
        ? { global: settingsManager.getGlobalSettings(), project: settingsManager.getProjectSettings(), safeMode: this.safeMode, accessLevel: this.accessLevel }
        : { safeMode: this.safeMode, accessLevel: this.accessLevel },
      extensions: { enabled: !this.safeMode, accessGate: true },
      providerState: { agentDir: this.agentDir },
    });
  }

  private async externalSessionShells(): Promise<UiSession[]> {
    if (this.safeMode) return [];
    const store = this.claudeSessionStore();
    if (!store) return [];
    const records = await store.list();
    return records.map((record) => {
      const firstUser = record.messages.find((message) => message.role === "user");
      return {
        id: record.tauSessionId,
        path: claudeSessionPath(record.tauSessionId),
        title: cleanThreadTitle(safeSessionTitle(record.title) || firstSentence(visibleTitleText(firstUser?.text ?? ""))),
        modifiedAt: record.updatedAt,
        projectPath: record.cwd,
        projectName: this.projectNameFor(record.cwd),
        branch: this.branchFor(record.cwd),
        messageCount: record.messages.length,
        backendKind: "claude-code",
      };
    });
  }

  private async refreshThreadIndex(publish: boolean): Promise<ThreadIndexSnapshot> {
    if (!this.threadIndexRefresh) {
      const scanStartedAt = Date.now();
      this.threadIndexRefresh = (async () => {
        const sessionInfos = await SessionManager.listAll();
        const scanned = await mapSessions(
          sessionInfos,
          this.cwd,
          async (cwd) => this.branchFor(cwd),
          (cwd) => this.projectNameFor(cwd),
        );
        const external = await this.externalSessionShells();
        const byId = new Map(scanned.map((session) => [session.id, session] as const));
        for (const session of external) if (!byId.has(session.id)) byId.set(session.id, session);
        this.sessions = mergeSessionIndexScan([...byId.values()], this.sessions, scanStartedAt, this.liveSessionIds());
        return this.threadIndexSnapshot();
      })().finally(() => {
        this.threadIndexRefresh = undefined;
      });
    }
    const threadIndex = await this.threadIndexRefresh;
    if (publish) this.emit({ type: "thread-index", threadIndex });
    return threadIndex;
  }

  private startIndexRecovery(): void {
    if (this.indexRecoveryTimer) return;
    this.indexRecoveryTimer = setInterval(() => {
      void this.recoverThreadIndex().catch((error) => this.fail(error));
    }, 30_000);
    this.indexRecoveryTimer.unref?.();
  }

  private async recoverThreadIndex(): Promise<void> {
    const previous = this.sessions;
    const scanStartedAt = Date.now();
    const sessionInfos = await SessionManager.listAll();
    const scanned = await mapSessions(
      sessionInfos,
      this.cwd,
      async (cwd) => this.branchFor(cwd),
      (cwd) => this.projectNameFor(cwd),
    );
    const external = await this.externalSessionShells();
    const byId = new Map(scanned.map((session) => [session.id, session] as const));
    for (const session of external) if (!byId.has(session.id)) byId.set(session.id, session);
    const next = mergeSessionIndexScan([...byId.values()], this.sessions, scanStartedAt, this.liveSessionIds());
    this.sessions = next;
    for (const update of sessionIndexUpdates(previous, next)) this.emitUpdate(update);
  }

  /** Prompt completion updates one shell; the global scan is a startup/recovery path. */
  private async refreshActiveThreadIndex(touch = true): Promise<void> {
    const thread = this.active;
    if (!thread) return;
    await this.refreshThreadShell(thread, touch);
  }

  private sessionShellPath(thread: ThreadRuntime): string {
    return threadBackendKind(thread) === "claude-code"
      ? claudeSessionPath(thread.sessionId)
      : thread.sessionFile ?? thread.sessionId;
  }

  private async refreshThreadShell(thread: ThreadRuntime, touch: boolean): Promise<void> {
    const projectPath = thread.cwd;
    if (!isPiBackend(thread)) {
      const existing = this.sessions.find((entry) => entry.id === thread.sessionId);
      const visibleMessages = this.messageSnapshot(thread);
      const shell = reconcileActiveThreadShell({
        id: thread.sessionId,
        path: this.sessionShellPath(thread),
        explicitTitle: safeSessionTitle(thread.adapterTitle),
        derivedTitle: firstSentence(visibleTitleText(visibleMessages.find((message) => message.role === "user")?.text ?? "")),
        now: Date.now(),
        projectPath,
        projectName: this.projectNameFor(projectPath),
        branch: this.branchFor(projectPath),
        messageCount: visibleMessages.length,
        backendKind: threadBackendKind(thread),
      }, existing, touch);
      this.sessions = [shell, ...this.sessions.filter((item) => item.id !== shell.id)];
      this.publishThreadShellSoon(shell);
      return;
    }
    const session = thread.session;
    const existing = this.sessions.find((entry) => entry.id === session.sessionId);
    const shell = reconcileActiveThreadShell({
      id: session.sessionId,
      path: this.sessionShellPath(thread),
      explicitTitle: safeSessionTitle(session.sessionName) || safeSessionTitle(thread.adapterTitle),
      derivedTitle: firstSentence(visibleTitleText(this.messageSnapshot(thread).find((message) => message.role === "user")?.text ?? "")),
      now: Date.now(),
      projectPath,
      projectName: this.projectNameFor(projectPath),
      branch: this.branchFor(projectPath),
      messageCount: session.messages.length + (thread.adapterMessages?.length ?? 0),
      backendKind: threadBackendKind(thread),
    }, existing, touch);
    this.sessions = [shell, ...this.sessions.filter((item) => item.id !== shell.id)];
    this.publishThreadShellSoon(shell);
  }

  private retitleShell(sessionId: string, title: string): void {
    const shell = this.sessions.find((entry) => entry.id === sessionId);
    if (!shell || shell.title === title) return;
    const titled = { ...shell, title };
    this.sessions = this.sessions.map((entry) => entry.id === sessionId ? titled : entry);
    this.publishThreadShellSoon(titled);
  }

  private publishThreadShellSoon(shell: UiSession): void {
    this.pendingShellUpdates.set(shell.id, shell);
    if (this.activeIndexPublish !== undefined) return;
    this.activeIndexPublish = setTimeout(() => {
      this.activeIndexPublish = undefined;
      const updates = [...this.pendingShellUpdates.values()];
      this.pendingShellUpdates.clear();
      for (const pending of updates) {
        this.emitUpdate({
          version: HOST_PROTOCOL_VERSION,
          type: "thread-shell",
          update: { sessionId: pending.id, shell: pending },
        });
      }
    }, 0);
    this.activeIndexPublish.unref?.();
  }

  private threadIndexSnapshot(): ThreadIndexSnapshot {
    const projects = this.projectHistory.list();
    const knownPaths = new Set(projects.map((project) => project.path));
    for (const thread of this.sessions) {
      if (knownPaths.has(thread.projectPath) || this.projectHistory.isHidden(thread.projectPath)) continue;
      projects.push({
        path: thread.projectPath,
        name: thread.projectName,
        lastOpenedAt: thread.modifiedAt,
      });
      knownPaths.add(thread.projectPath);
    }
    projects.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
    return { projects, sessions: this.sessions };
  }

  private branchMessagesWithEntryIds(thread: ThreadRuntime): unknown[] {
    const manager = thread.session.sessionManager;
    if (!manager?.getBranch) return thread.session.messages;
    const entries = manager.getBranch();
    const messages = branchMessagesWithClientMessageIds(entries, knownSkillNames(this.composerCommands(thread)));
    let messageIndex = 0;
    return entries.flatMap((entry) => entry.type === "message"
      ? [{ ...(messages[messageIndex++] as Record<string, unknown>), tauEntryId: entry.id }]
      : []);
  }

  private appendClientMessageMarker(
    thread: ThreadRuntime,
    clientMessageId: string | undefined,
    correlationText?: string,
    preparedFingerprint?: string,
  ): boolean {
    if (!clientMessageId) return false;
    thread.pendingClientMessageFingerprints ??= new Map<string, string>();
    thread.pendingClientMessageIds.push(clientMessageId);
    const fingerprint = preparedFingerprint ?? (correlationText === undefined
      ? undefined
      : clientMessageFingerprint(correlationText, knownSkillNames(this.composerCommands(thread))));
    if (fingerprint) thread.pendingClientMessageFingerprints.set(clientMessageId, fingerprint);
    thread.session.sessionManager.appendCustomEntry(CLIENT_MESSAGE_MARKER, clientMessageMarker(clientMessageId, fingerprint).data);
    return true;
  }

  private trackedClientMessageIds(thread: ThreadRuntime): string[] {
    return [...new Set([
      ...thread.pendingClientMessageIds,
      ...thread.inFlightClientMessageIds,
    ])];
  }

  /** Only a runtime-persisted id proves that a marker's request was recorded. */
  private persistedClientMessageIds(thread: ThreadRuntime): Set<string> {
    return new Set(branchMessagesWithClientMessageIds(thread.session.sessionManager.getBranch(), knownSkillNames(this.composerCommands(thread))).flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const value = message as { role?: unknown; clientMessageId?: unknown };
      return value.role === "user" && typeof value.clientMessageId === "string" && value.clientMessageId.length > 0
        ? [value.clientMessageId]
        : [];
    }));
  }

  private forgetClientMessageId(thread: ThreadRuntime, clientMessageId: string): void {
    for (;;) {
      const pending = thread.pendingClientMessageIds.indexOf(clientMessageId);
      if (pending < 0) break;
      thread.pendingClientMessageIds.splice(pending, 1);
    }
    thread.inFlightClientMessageIds.delete(clientMessageId);
    thread.pendingClientMessageFingerprints.delete(clientMessageId);
  }

  private cancelClientMessageMarker(thread: ThreadRuntime, clientMessageId: string | undefined): boolean {
    if (!clientMessageId) return false;
    const wasPending = thread.pendingClientMessageIds.includes(clientMessageId);
    const wasInFlight = thread.inFlightClientMessageIds.delete(clientMessageId);
    if (!wasPending && !wasInFlight) return false;
    this.forgetClientMessageId(thread, clientMessageId);
    thread.session.sessionManager.appendCustomEntry(CLIENT_MESSAGE_CANCEL_MARKER, clientMessageCancelMarker(clientMessageId).data);
    return true;
  }

  private failClientMessageIfUnpersisted(thread: ThreadRuntime, clientMessageId: string | undefined, sessionId = thread.sessionId): boolean {
    if (!clientMessageId) return false;
    if (this.persistedClientMessageIds(thread).has(clientMessageId)) {
      this.forgetClientMessageId(thread, clientMessageId);
      return false;
    }
    const cancelled = this.cancelClientMessageMarker(thread, clientMessageId);
    if (cancelled) {
      this.emit({
        type: "user-message-failed",
        sessionId,
        clientMessageId,
        message: "Pi did not add the prompt to the transcript.",
      });
    }
    return cancelled;
  }

  private correlateUserMessageStart(thread: ThreadRuntime, message: unknown): void {
    if (!message || typeof message !== "object") return;
    const value = message as { role?: string; clientMessageId?: unknown };
    if (value.role !== "user") return;
    if (typeof value.clientMessageId === "string") {
      const pending = thread.pendingClientMessageIds.indexOf(value.clientMessageId);
      if (pending >= 0) {
        thread.pendingClientMessageIds.splice(pending, 1);
        thread.inFlightClientMessageIds.add(value.clientMessageId);
      }
      return;
    }
    thread.pendingClientMessageFingerprints ??= new Map<string, string>();
    const clientMessageId = matchClientMessageId(
      thread.pendingClientMessageIds,
      thread.pendingClientMessageFingerprints,
      message,
      knownSkillNames(this.composerCommands(thread)),
    );
    if (clientMessageId) {
      const pending = thread.pendingClientMessageIds.indexOf(clientMessageId);
      if (pending >= 0) thread.pendingClientMessageIds.splice(pending, 1);
      thread.inFlightClientMessageIds.add(clientMessageId);
      (message as Record<string, unknown>).clientMessageId = clientMessageId;
    }
  }

  private decorateUserEvent(thread: ThreadRuntime, message: unknown): unknown {
    if (!message || typeof message !== "object") return message;
    const value = message as { role?: string; clientMessageId?: string };
    if (value.role !== "user") return message;
    const directId = typeof value.clientMessageId === "string" && value.clientMessageId.length > 0
      ? value.clientMessageId
      : undefined;
    const manager = thread.session.sessionManager;
    const fingerprintId = thread.pendingClientMessageFingerprints
      ? matchClientMessageId(thread.pendingClientMessageIds, thread.pendingClientMessageFingerprints, message, knownSkillNames(this.composerCommands(thread)))
      : undefined;
    const clientMessageId = directId
      ?? (manager?.getBranch ? clientMessageIdForMessage(manager.getBranch(), message, knownSkillNames(this.composerCommands(thread))) : undefined);
    const resolvedClientMessageId = clientMessageId ?? fingerprintId;
    if (resolvedClientMessageId) this.forgetClientMessageId(thread, resolvedClientMessageId);
    return directId || !resolvedClientMessageId ? message : { ...value, clientMessageId: resolvedClientMessageId };
  }

  private messageSnapshot(thread: ThreadRuntime): UiMessage[] {
    if (!isPiBackend(thread)) {
      return [...thread.adapterMessages];
    }
    const mapping = this.messageMappingOptions(thread);
    const messages = this.branchMessagesWithEntryIds(thread)
      .map((message, index) => mapMessage(message, index, mapping))
      .filter((message): message is UiMessage => Boolean(message?.text || message?.skill));
    messages.push(...(thread.adapterMessages ?? []));
    // Text still streaming is not in the session yet; without it a thread opened
    // mid-answer would look silent until the answer finished.
    const live = thread.liveAssistant;
    if (live && live.text) {
      messages.push({ id: live.id, role: "assistant", text: live.text, thinking: live.thinking || undefined, timestamp: live.timestamp });
    }
    return messages;
  }

  /** Persisted turn activity, with the host's live output for tools still running. */
  private turnActivity(thread: ThreadRuntime, branchMessages: unknown[]): UiTurnActivity | undefined {
    const activity = lastTurnActivityFromMessages(branchMessages);
    if (!activity || thread.tools.size === 0) return activity;
    return {
      ...activity,
      tools: activity.tools.map((tool) => tool.status === "running" ? thread.tools.get(tool.id) ?? tool : tool),
    };
  }

  private composerCommands(thread: ThreadRuntime): UiComposerCommand[] {
    if (!isPiBackend(thread) && thread.backend) return this.claudeComposerCommands(thread.cwd);
    const loader = thread.session.resourceLoader;
    const commands = new Map<string, UiComposerCommand>();
    for (const extension of loader.getExtensions().extensions) {
      if (extension.hidden) continue;
      for (const command of extension.commands.values()) {
        if (command.name.startsWith("tau-bridge-")) continue;
        commands.set(command.name, {
          name: command.name,
          description: command.description,
          source: "extension",
        });
      }
    }
    for (const prompt of loader.getPrompts().prompts) {
      if (commands.has(prompt.name)) continue;
      commands.set(prompt.name, {
        name: prompt.name,
        description: prompt.description,
        argumentHint: prompt.argumentHint,
        source: "prompt",
      });
    }
    if (thread.session.settingsManager.getEnableSkillCommands()) {
      for (const skill of loader.getSkills().skills) {
        commands.set(`skill:${skill.name}`, {
          name: `skill:${skill.name}`,
          description: skill.description,
          source: "skill",
          skillCommand: skillInvocationCommand(skill.name, thread.runtimeAdapter),
        });
      }
    }
    return [...commands.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  /** Claude gets only skill metadata from the shared skill directories. It
   * never creates a Pi resource loader or imports Pi transcript/context state. */
  private claudeComposerCommands(cwd: string): UiComposerCommand[] {
    if (this.runtimeCommands.length > 0) return this.runtimeCommands.map((command) => ({ ...command }));
    const result = loadSkills({ cwd, agentDir: this.agentDir, skillPaths: [], includeDefaults: true });
    return result.skills
      .filter((skill) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(skill.name))
      .map((skill) => ({
        name: `skill:${skill.name}`,
        description: skill.description,
        source: "skill" as const,
        skillCommand: skillInvocationCommand(skill.name, this.adapterFor("claude-code")),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private normalizeThreadPrompt(thread: ThreadRuntime, text: string): string {
    return normalizeSkillInvocationForRuntime(
      text,
      thread.runtimeAdapter,
      this.composerCommands(thread),
    );
  }

  private isExtensionCommand(thread: ThreadRuntime, text: string): boolean {
    if (!text.startsWith("/")) return false;
    const commandName = text.slice(1).split(/[ \t\r\n]/u, 1)[0];
    return this.composerCommands(thread).some((command) => command.source === "extension" && command.name === commandName);
  }

  private bridgeRuntimeAdapter(): AgentRuntimeAdapter {
    // The bridge is implemented by Pi itself. Its model provider is unrelated
    // to the Pi command dialect, so the host never derives this from snapshot.model.
    return PI_AGENT_RUNTIME_ADAPTER;
  }

  private composerCommandsForAdapter(
    commands: readonly UiComposerCommand[],
    adapter: AgentRuntimeAdapter,
  ): UiComposerCommand[] {
    return commands.map((command) => {
      if (command.source !== "skill" || command.skillCommand) return { ...command };
      const name = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
      return { ...command, skillCommand: skillInvocationCommand(name, adapter) };
    });
  }

  private messageMappingOptions(thread?: LiveTurnState): MessageMappingOptions {
    if (isThreadRuntime(thread)) {
      return {
        runtimeAdapter: thread.runtimeAdapter,
        skillCommands: this.composerCommands(thread),
      };
    }
    const runtimeAdapter = this.bridgeRuntimeAdapter();
    return {
      runtimeAdapter,
      skillCommands: this.composerCommandsForAdapter(this.bridgeSnapshot?.composerCommands ?? [], runtimeAdapter),
    };
  }

  private snapshotSync(models: UiModel[]): HostSnapshot {
    if (this.bridgeSnapshot) return { ...this.bridgeHostSnapshot(), models };
    const thread = this.requireActive();
    if (!isPiBackend(thread)) {
      const messages = this.messageSnapshot(thread);
      const firstUserMessage = messages.find((message) => message.role === "user");
      return {
        cwd: thread.cwd,
        sessionId: thread.sessionId,
        sessionName: safeSessionTitle(thread.adapterTitle),
        sessionTitle: cleanThreadTitle(safeSessionTitle(thread.adapterTitle) || firstSentence(visibleTitleText(firstUserMessage?.text ?? ""))),
        runtimeCapabilities: thread.runtimeAdapter.capabilities,
        backendKind: thread.backend.kind,
        models: [],
        thinkingLevel: "off",
        thinkingLevels: ["off"],
        messages,
        isStreaming: thread.adapterStreaming || thread.backend.isStreaming(),
        activeTools: [],
        taskProgress: undefined,
        taskHistory: [],
        allTools: [],
        composerCommands: this.composerCommands(thread),
        extensionCount: 0,
        serviceTier: "standard",
        serviceTierAvailable: false,
      };
    }
    const session = thread.session;
    const branchMessages = this.branchMessagesWithEntryIds(thread);
    const messages = this.messageSnapshot(thread);
    const firstUserMessage = messages.find((message) => message.role === "user");
    const usage = session.getContextUsage();
    return {
      cwd: this.cwd,
      sessionId: session.sessionId,
      sessionName: safeSessionTitle(session.sessionName),
      sessionTitle: cleanThreadTitle(safeSessionTitle(session.sessionName) || safeSessionTitle(thread.adapterTitle) || firstSentence(visibleTitleText(firstUserMessage?.text ?? ""))),
      model: session.model ? mapModel(session.model) : undefined,
      runtimeCapabilities: thread.runtimeAdapter.capabilities,
      backendKind: thread.backend.kind,
      models,
      thinkingLevel: session.thinkingLevel,
      thinkingLevels: session.getAvailableThinkingLevels(),
      messages,
      isStreaming: session.isStreaming || thread.adapterStreaming,
      activeTools: session.getActiveToolNames(),
      turnActivity: this.turnActivity(thread, branchMessages),
      taskProgress: taskProgressFromMessages(branchMessages),
      taskHistory: taskProgressHistoryFromMessages(branchMessages),
      allTools: session.getAllTools().map((tool) => ({ name: tool.name, description: tool.description })),
      composerCommands: this.composerCommands(thread),
      extensionCount: this.extensionCount,
      serviceTier: this.serviceTier,
      serviceTierAvailable: this.serviceTierAvailable(),
      contextUsage: usage && usage.tokens !== null && usage.percent !== null
        ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
        : undefined,
    };
  }

  private requestApproval(
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
    sessionId: string,
  ): Promise<AccessDecision> {
    const id = `${toolCallId}-${(this.approvalCounter += 1)}`;
    return new Promise<AccessDecision>((resolve) => {
      let settled = false;
      const settle = (decision: AccessDecision) => {
        if (settled) return;
        settled = true;
        this.pendingApprovals.delete(id);
        resolve(decision);
      };
      // No deadline: an unanswered approval is a paused thread, not a refusal.
      // Only that thread waits, and stopping the run settles it.
      this.pendingApprovals.set(id, { sessionId, settle });
      this.emit({
        type: "tool-approval",
        request: { id, sessionId, toolName, summary: approvalSummary(toolName, input) },
      });
    });
  }

  private askExtensionUi(prompt: ExtensionUiPrompt): Promise<ExtensionUiAnswer> {
    // The user already typed the answer for the select before this; the
    // extension is only asking for it now in its own words.
    const typed = prompt.kind === "input" ? this.typedAnswers.get(prompt.sessionId) : undefined;
    if (typed) {
      this.typedAnswers.delete(prompt.sessionId);
      if (typed.expiresAt > Date.now()) {
        this.log("extension-ui.typed", prompt.title.split("\n")[0]);
        return Promise.resolve({ value: typed.text });
      }
    }
    this.attachQuestionnaire(prompt);
    return new Promise<ExtensionUiAnswer>((resolve) => {
      let settled = false;
      const settle = (answer: ExtensionUiAnswer) => {
        if (settled) return;
        settled = true;
        this.pendingUiPrompts.delete(prompt.id);
        this.openUiPrompts.delete(prompt.id);
        if (timer) clearTimeout(timer);
        this.emit({ type: "extension-ui-resolved", id: prompt.id });
        resolve(answer);
      };
      // Only the extension's own deadline ends a question. Without one the
      // thread simply waits: a question is a stop until the user answers, and
      // an answer invented by a timer would send the run off in the wrong direction.
      const timer = prompt.expiresAt
        ? setTimeout(() => {
          this.log("extension-ui.timeout", prompt.title);
          settle({ cancelled: true });
        }, Math.max(0, prompt.expiresAt - Date.now()))
        : undefined;
      timer?.unref?.();
      this.pendingUiPrompts.set(prompt.id, { sessionId: prompt.sessionId, settle });
      this.openUiPrompts.set(prompt.id, prompt);
      this.log("extension-ui.prompt", `${prompt.kind}: ${prompt.title}`);
      this.emit({ type: "extension-ui-prompt", prompt });
    });
  }

  /** Places a prompt inside the questionnaire it came from, by its question text. */
  private attachQuestionnaire(prompt: ExtensionUiPrompt): void {
    if (prompt.kind !== "select" && prompt.kind !== "input") return;
    const questionnaire = this.questionnaires.get(prompt.sessionId);
    if (!questionnaire) return;
    const { questions } = questionnaire;
    const byTitle = questions.findIndex((q) => prompt.title.startsWith(`${q.header ? `[${q.header}] ` : ""}${q.question}`));
    const index = byTitle >= 0 ? byTitle : Math.min(questionnaire.asked, questions.length - 1);
    questionnaire.asked = index + 1;
    prompt.questionnaire = { index, questions };
  }

  answerExtensionUi(id: string, answer: ExtensionUiAnswer): void {
    const prompt = this.openUiPrompts.get(id);
    // Text typed for a select goes through the extension's own free-text row:
    // pick that row, then hand the text to the input prompt it asks with next.
    // Answering the select with raw text would read as a dismissal instead.
    if (prompt?.kind === "select" && "typed" in answer && answer.typed && "value" in answer) {
      const sentinel = freeTextOption(prompt.options);
      if (sentinel) {
        this.typedAnswers.set(prompt.sessionId, { text: answer.value, expiresAt: Date.now() + TYPED_ANSWER_TTL_MS });
        this.pendingUiPrompts.get(id)?.settle({ value: sentinel });
        return;
      }
    }
    this.pendingUiPrompts.get(id)?.settle(answer);
  }

  /** Re-announces questions raised before the renderer was listening. */
  replayOpenUiPrompts(): void {
    for (const prompt of this.openUiPrompts.values()) {
      this.emit({ type: "extension-ui-prompt", prompt });
    }
  }

  private hasOpenUiPrompts(sessionId: string): boolean {
    for (const pending of this.pendingUiPrompts.values()) {
      if (pending.sessionId === sessionId) return true;
    }
    return false;
  }

  private cancelUiPromptsFor(sessionId: string): void {
    const pending = [...this.pendingUiPrompts.values()].filter((entry) => entry.sessionId === sessionId);
    pending.forEach((entry) => entry.settle({ cancelled: true }));
  }

  private settleApprovalsFor(sessionId: string, decision: AccessDecision): void {
    const pending = [...this.pendingApprovals.values()].filter((entry) => entry.sessionId === sessionId);
    pending.forEach((entry) => entry.settle(decision));
  }

  private settleAllApprovals(decision: AccessDecision): void {
    const pending = [...this.pendingApprovals.values()];
    this.pendingApprovals.clear();
    pending.forEach((entry) => entry.settle(decision));
  }

  private resolveBranch(cwd: string): Promise<string | undefined> {
    return this.gitCoordinator.getBranch(cwd);
  }

  private invalidateGitAfterTool(tool: UiToolRun, cwd: string): void {
    const command = typeof tool.args.command === "string" ? tool.args.command : "";
    const mutatesGit = /\bgit\s+(?:checkout|switch|branch|reset|worktree|commit|merge|rebase|pull|fetch)\b/iu.test(command);
    if (tool.name === "edit" || tool.name === "write" || mutatesGit) {
      this.gitCoordinator.invalidate(cwd, mutatesGit
        ? ["status", "branch", "workspace"]
        : ["status", "workspace"]);
    }
  }

  private async readTree(path: string, depth: number, budget: { count: number }): Promise<FileNode[]> {
    if (depth > 4 || budget.count > 320) return [];
    const entries = await readdir(path, { withFileTypes: true });
    const nodes: FileNode[] = [];
    for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (budget.count++ > 320) break;
      if (entry.name.startsWith(".") && entry.name !== ".pi") continue;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const fullPath = join(path, entry.name);
      const node: FileNode = {
        name: entry.name,
        path: fullPath,
        kind: entry.isDirectory() ? "directory" : "file",
      };
      nodes.push(node);
    }
    return nodes;
  }

  private logRuntimePhase(phase: string, startedAt: number, reason: string, cwd: string, note?: string): void {
    this.lifecycleMetrics.phase(phase, startedAt);
    const elapsed = Math.round((performance.now() - startedAt) * 10) / 10;
    const detail = `${elapsed}ms · ${reason} · ${basename(cwd) || cwd}`;
    this.log(`runtime.${phase}.ready`, note ? `${detail} · ${note}` : detail);
  }

  private logReplacement(reason: string, startedAt: number): void {
    const elapsed = Math.round((performance.now() - startedAt) * 10) / 10;
    this.log("runtime.replace.ready", `${elapsed}ms · ${reason}`);
  }

  private emitUpdate(update: HostUpdate): void {
    this.emit({ type: "host-update", update });
  }

  private log(label: string, detail?: string): void {
    const event = { type: "event-log" as const, label, detail, timestamp: Date.now() };
    this.emit(event);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private fail(error: unknown): void {
    const message = this.errorMessage(error);
    this.emit({ type: "error", message });
    this.log("host.error", message);
  }
}

export function workspaceLabel(cwd: string): string {
  return basename(cwd) || cwd;
}
