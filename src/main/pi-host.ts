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
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  AccessLevel,
  CommitResult,
  DiffLoadOptions,
  FileNode,
  HostBootstrap,
  HostEvent,
  HostSnapshot,
  ThreadIndexSnapshot,
  UiEditor,
  UiFileDiff,
  UiMessage,
  UiModel,
  UiSession,
  UiToolRun,
  UiWorkspaceChanges,
  WorkspaceInfo,
} from "../shared/contracts.js";
import { HOST_PROTOCOL_VERSION, catalogFromSnapshot, detailFromSnapshot, type HostActionResult, type HostUpdate, type ThreadDetail, type TranscriptPage } from "../shared/host-protocol.js";
import { ThreadDetailStore } from "../shared/thread-detail-store.js";
import { TranscriptPager } from "../shared/transcript-pager.js";
import { HostLifecycleInstrumentation } from "./host-lifecycle.js";
import { RuntimeResourceCache, runtimeResourceFingerprint } from "./runtime-resource-cache.js";
import { cachedResourceOptions, captureResourceDiscovery, type ResourceDiscoverySnapshot } from "./resource-discovery-cache.js";
import { createAccessExtension, type AccessDecision } from "./access-extension.js";
import { GitCoordinator } from "./git-coordinator.js";
import { ProjectHistory } from "./project-history.js";
import * as workspaceGit from "./workspace-git.js";
import { ToolOutputBatcher } from "./tool-output-batcher.js";
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "dist-electron", ".next"]);

type Emit = (event: HostEvent) => void;
type RuntimeStartEvent = Parameters<CreateAgentSessionRuntimeFactory>[0]["sessionStartEvent"];

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

function mapMessage(message: unknown, index: number): UiMessage | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = message as {
    role?: string;
    content?: unknown;
    timestamp?: number;
    customType?: string;
  };

  if (value.role === "user") {
    return {
      id: `user-${value.timestamp ?? index}-${index}`,
      role: "user",
      text: textFromContent(value.content),
      timestamp: value.timestamp ?? Date.now(),
    };
  }

  if (value.role === "assistant") {
    return {
      id: `assistant-${value.timestamp ?? index}-${index}`,
      role: "assistant",
      text: textFromContent(value.content),
      thinking: thinkingFromContent(value.content),
      timestamp: value.timestamp ?? Date.now(),
    };
  }

  if (value.role === "custom" && value.customType) {
    return {
      id: `notice-${value.timestamp ?? index}-${index}`,
      role: "notice",
      text: textFromContent(value.content),
      timestamp: value.timestamp ?? Date.now(),
    };
  }

  return undefined;
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

function cleanGeneratedTitle(value: string): string {
  const firstLine = value.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? "";
  const title = firstLine
    .replace(/^(?:title|thread title)\s*:\s*/iu, "")
    .replace(/^[#*`"'“”‘’]+|[#*`"'“”‘’]+$/gu, "")
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
      title: session.name || firstSentence(session.firstMessage),
      modifiedAt: session.modified.getTime(),
      projectPath,
      projectName: basename(projectPath) || projectPath,
      branch: branches.get(projectPath),
      messageCount: session.messageCount,
    };
  });
}

function sessionShellEqual(left: UiSession, right: UiSession): boolean {
  return left.id === right.id && left.path === right.path && left.title === right.title &&
    left.modifiedAt === right.modifiedAt && left.projectPath === right.projectPath &&
    left.projectName === right.projectName && left.branch === right.branch &&
    left.messageCount === right.messageCount;
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

export function mergeSessionIndexScan(scanned: UiSession[], current: UiSession[], scanStartedAt: number): UiSession[] {
  const newer = new Map(current
    .filter((session) => session.modifiedAt >= scanStartedAt)
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

export class PiHost {
  private cwd: string;
  private emit: Emit;
  private runtime?: AgentSessionRuntime;
  private unsubscribe?: () => void;
  private readonly agentDir = getAgentDir();
  private extensionCount = 0;
  private currentAssistantId?: string;
  private tools = new Map<string, UiToolRun>();
  private readonly lifecycleMetrics = new HostLifecycleInstrumentation();
  private readonly gitCoordinator = new GitCoordinator({ onSubprocess: () => this.lifecycleMetrics.countSubprocess() });
  private readonly modelCatalogCache = new RuntimeResourceCache<UiModel[]>({ maxEntries: 8, ttlMs: 5 * 60_000 });
  private readonly resourceDiscoveryCache = new RuntimeResourceCache<ResourceDiscoverySnapshot>({ maxEntries: 4, ttlMs: 5 * 60_000 });
  private readonly prewarmedRuntimes = new Map<string, Promise<AgentSessionRuntime | undefined>>();
  private readonly prewarmManagers = new WeakSet<SessionManager>();
  private readonly preboundSessions = new WeakSet<AgentSession>();
  private readonly backgroundLifecycle: Array<{ name: string; durationMs: number }> = [];
  private retirementQueue: Promise<void> = Promise.resolve();
  private prewarmTimer?: ReturnType<typeof setTimeout>;
  private sessions: UiSession[] = [];
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private threadIndexRefresh?: Promise<ThreadIndexSnapshot>;
  private readonly detailStore = new ThreadDetailStore(5);
  private activeIndexPublish?: ReturnType<typeof setTimeout>;
  private indexRecoveryTimer?: ReturnType<typeof setInterval>;
  private projectBranch?: string;
  private branchResolution?: Promise<void>;
  private readonly pendingShellUpdates = new Map<string, UiSession>();
  private invalidationCount = 0;
  private accessLevel: AccessLevel = "full";
  private pendingApprovals = new Map<string, (decision: AccessDecision) => void>();
  private approvalCounter = 0;
  private readonly toolOutputBatcher: ToolOutputBatcher;
  private readonly createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const reason = sessionStartEvent?.reason ?? "initial";
    const scenario = reason === "initial" ? "bootstrap" : reason === "resume" ? "cold-switch" : "warm-switch";
    const ownsMeasurement = !this.lifecycleMetrics.isActive() && !this.prewarmManagers.has(sessionManager);
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
        extensionFactories: [{ name: "tau-access", factory: this.accessExtension }],
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
    requestApproval: (toolCallId, toolName, input) => this.requestApproval(toolCallId, toolName, input),
  });

  constructor(
    cwd: string,
    emit: Emit,
    private readonly projectHistory: ProjectHistory,
    private readonly safeMode = false,
    private readonly automaticPrewarm = true,
  ) {
    this.cwd = cwd;
    this.emit = (event) => {
      this.lifecycleMetrics.recordIpc(event);
      emit(event);
    };
    this.toolOutputBatcher = new ToolOutputBatcher((updates) => {
      for (const [id, output] of updates) this.emit({ type: "tool-update", id, output });
    });
  }

  async start(): Promise<HostBootstrap> {
    return this.runLifecycle(async () => {
      this.lifecycleMetrics.begin(this.safeMode ? "safe" : "full", "bootstrap");
      try {
        await this.projectHistory.remember(this.cwd);
        await this.initializeRuntime(SessionManager.continueRecent(this.cwd));
        this.resolveProjectBranchInBackground();
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
    const session = this.requireSession();
    if (session.sessionId !== sessionId) throw new Error("Cannot load a non-active session transcript");
    const result = TranscriptPager.pageFor(sessionId, this.messageSnapshot(), 40, cursor);
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
      { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) },
      { version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) },
      { version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd: snapshot.cwd, branch: snapshot.branch } },
      ...(shell ? [{ version: HOST_PROTOCOL_VERSION, type: "thread-shell" as const, update: { sessionId: shell.id, shell } }] : []),
    ];
  }

  async setWorkspace(cwd: string): Promise<HostActionResult> {
    return this.runLifecycle(() => this.setWorkspaceNow(cwd));
  }

  private async setWorkspaceNow(cwd: string): Promise<HostActionResult> {
    if (cwd === this.cwd) return this.actionResult(this.lifecycleUpdates(await this.snapshot()));
    void this.clearPreparedRuntimes().catch((error) => this.fail(error));
    const startedAt = performance.now();
    const previousSessionFile = this.runtime?.session.sessionFile;
    const nextRuntime = await this.createRootRuntime(
      cwd,
      SessionManager.continueRecent(cwd),
      { type: "session_start", reason: "resume", previousSessionFile },
    );
    await this.swapRootRuntime(nextRuntime);
    await this.projectHistory.remember(this.cwd);
    this.logReplacement("workspace", startedAt);
    await this.refreshActiveThreadIndex();
    return this.actionResult(this.lifecycleUpdates(await this.snapshot()));
  }

  async newSession(): Promise<HostActionResult> {
    return this.runLifecycle(async () => {
      const startedAt = performance.now();
      const result = await this.replaceSession("new", (runtime) => runtime.newSession());
      if (!result.cancelled) {
        this.logReplacement("new", startedAt);
        await this.refreshActiveThreadIndex();
      }
      const snapshot = await this.snapshot();
      return this.actionResult(this.lifecycleUpdates(snapshot));
    });
  }

  async switchSession(path: string): Promise<HostActionResult> {
    return this.runLifecycle(async () => {
      const startedAt = performance.now();
      const prepared = this.prewarmedRuntimes.get(path);
      this.prewarmedRuntimes.delete(path);
      this.lifecycleMetrics.begin(this.safeMode ? "safe" : "full", prepared ? "warm-switch" : "cold-switch");
      try {
        const preparedRuntime = prepared ? await prepared : undefined;
        const result = preparedRuntime
          ? await this.activatePreparedRuntime(path, preparedRuntime)
          : await this.replaceSession("resume", (runtime) => runtime.switchSession(path));
        if (!result.cancelled) {
          this.cwd = this.requireRuntime().cwd;
          await this.projectHistory.remember(this.cwd);
          this.logReplacement("resume", startedAt);
          await this.refreshActiveThreadIndex();
          this.scheduleRuntimePrewarm();
        }
        const snapshot = await this.snapshot();
        return this.actionResult(this.lifecycleUpdates(snapshot));
      } finally {
        this.lifecycleMetrics.end();
      }
    });
  }

  /** Prepares a fresh, isolated runtime without binding its extension lifecycle. */
  async prewarmSession(path: string): Promise<void> {
    if (this.safeMode || path === this.runtime?.session.sessionFile || this.prewarmedRuntimes.has(path)) return;
    const promise = this.createPreparedRuntime(path).catch((error) => {
      this.log("runtime.prewarm.failed", this.errorMessage(error));
      return undefined;
    });
    this.prewarmedRuntimes.set(path, promise);
    await promise;
  }

  async prompt(text: string): Promise<void> {
    const session = this.requireSession();
    this.log("prompt.accepted", text.slice(0, 80));
    try {
      await session.prompt(text, {
        streamingBehavior: session.isStreaming ? "followUp" : undefined,
      });
      if (this.runtime?.session === session) await this.refreshActiveThreadIndex();
    } catch (error) {
      if (this.runtime?.session !== session) return;
      this.fail(error);
      throw error;
    }
  }

  async steer(text: string): Promise<void> {
    try {
      await this.requireSession().steer(text);
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }

  async abort(): Promise<void> {
    this.settleAllApprovals({ allowed: false, reason: "Blocked by Tau: the run was stopped." });
    await this.requireSession().abort();
  }

  async setModel(provider: string, id: string): Promise<HostActionResult> {
    return this.runLifecycle(async () => {
      const session = this.requireSession();
      const model = session.modelRuntime.getModel(provider, id);
      if (!model) throw new Error(`Unknown model: ${provider}/${id}`);
      await session.setModel(model);
      this.log("model.changed", `${provider}/${id}`);
      const snapshot = await this.snapshot();
      const catalog = { version: HOST_PROTOCOL_VERSION, type: "catalog" as const, catalog: catalogFromSnapshot(snapshot) };
      this.emitUpdate(catalog);
      return this.actionResult([catalog]);
    });
  }

  async setThinkingLevel(level: string): Promise<HostActionResult> {
    return this.runLifecycle(async () => {
      const session = this.requireSession();
      if (!session.getAvailableThinkingLevels().includes(level as never)) {
        throw new Error(`Thinking level is not available: ${level}`);
      }
      session.setThinkingLevel(level as never);
      this.log("thinking.changed", level);
      const snapshot = await this.snapshot();
      const catalog = { version: HOST_PROTOCOL_VERSION, type: "catalog" as const, catalog: catalogFromSnapshot(snapshot) };
      this.emitUpdate(catalog);
      return this.actionResult([catalog]);
    });
  }

  async generateThreadTitle(provider: string, modelId: string, force = false): Promise<HostActionResult> {
    const session = this.requireSession();
    if (session.isStreaming) throw new Error("Wait for the active agent run before generating a title.");
    if (session.sessionName && !force) return { version: HOST_PROTOCOL_VERSION, updates: [] };
    const model = session.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`Unknown title model: ${provider}/${modelId}`);
    const conversation = session.messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(0, 4)
      .map((message) => `${message.role}: ${textFromContent(message.content)}`)
      .filter((line) => line.trim().length > line.indexOf(":") + 1)
      .join("\n\n")
      .slice(0, 6000);
    if (!conversation) throw new Error("The thread has no conversation to title yet.");

    this.log("title.started", `${provider}/${modelId}`);
    const response = await session.modelRuntime.completeSimple(
      model,
      {
        systemPrompt: "Create concise titles for coding-agent threads. Return only the title, with no quotes, label, or explanation.",
        messages: [{
          role: "user",
          content: [{
            type: "text",
            text: `Write a specific 3-7 word title for this thread. Prefer the task or decision over generic words such as help, question, or coding.\n\n${conversation}`,
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
    const title = cleanGeneratedTitle(textFromContent(response.content));
    if (this.runtime?.session !== session) return { version: HOST_PROTOCOL_VERSION, updates: [] };
    session.setSessionName(title);
    this.sessions = this.sessions.map((thread) =>
      thread.id === session.sessionId ? { ...thread, title, modifiedAt: Date.now() } : thread,
    );
    this.log("title.generated", title);
    const update: HostUpdate = {
      version: HOST_PROTOCOL_VERSION,
      type: "thread-shell",
      update: { sessionId: session.sessionId, shell: this.sessions.find((thread) => thread.id === session.sessionId) },
    };
    this.emitUpdate(update);
    return this.actionResult([update]);
  }

  setAccessLevel(level: AccessLevel): void {
    if (level === this.accessLevel) return;
    this.accessLevel = level;
    this.log("access.level", level);
    // Anything already waiting was queued under the previous rules; let it through
    // only if the new level does not require asking.
    if (level === "full") this.settleAllApprovals({ allowed: true });
    if (level === "read-only") {
      this.settleAllApprovals({ allowed: false, reason: "Blocked by Tau: switched to read-only." });
    }
  }

  resolveToolApproval(id: string, allowed: boolean): void {
    this.pendingApprovals.get(id)?.({
      allowed,
      reason: allowed ? undefined : "Blocked by Tau: you declined this tool call.",
    });
    this.pendingApprovals.delete(id);
  }

  async compactContext(): Promise<HostActionResult> {
    return this.runLifecycle(async () => {
      await this.requireSession().compact();
      this.log("context.compacted");
      const snapshot = await this.snapshot();
      const update: HostUpdate = { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot) };
      this.emitUpdate(update);
      return this.actionResult([update]);
    });
  }

  async snapshot(): Promise<HostSnapshot> {
    const branchStartedAt = performance.now();
    const branchPromise = this.resolveBranch(this.cwd).then((branch) => {
      this.lifecycleMetrics.phase("branch", branchStartedAt);
      return branch;
    });
    const [models, branch] = await Promise.all([this.ensureModels(), branchPromise]);
    this.projectBranch = branch;
    return { ...this.snapshotSync(models), branch };
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

  async createWorktree(branch: string): Promise<HostActionResult> {
    return this.runLifecycle(async () => {
      const project = this.cwd;
      try {
        const destination = await workspaceGit.createWorktree(project, branch, (cwd) => this.gitCoordinator.getWorkspaceInfo(cwd));
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
        if (target === this.cwd) return this.actionResult(this.lifecycleUpdates(await this.snapshot()));
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
      this.pendingShellUpdates.clear();
      const teardownErrors: unknown[] = [];
      try { await this.clearPreparedRuntimes(); } catch (error) { teardownErrors.push(error); }
      try { await this.retirementQueue; } catch (error) { teardownErrors.push(error); }
      const runtime = this.runtime;
      if (runtime) teardownErrors.push(...await this.shutdownRuntime(runtime));
      if (this.runtime === runtime) this.runtime = undefined;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.resetSessionState();
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

  private async initializeRuntime(sessionManager: SessionManager): Promise<void> {
    const runtime = await this.createRootRuntime(sessionManager.getCwd() || this.cwd, sessionManager);
    this.installRuntime(runtime);
    try {
      await this.bindSession(runtime, runtime.session);
    } catch (error) {
      const cleanupErrors = await this.shutdownRuntime(runtime);
      if (this.runtime === runtime) this.runtime = undefined;
      throw cleanupErrors.length > 0
        ? new AggregateError([error, ...cleanupErrors], "Pi runtime initialization failed")
        : error;
    }
  }

  private async createRootRuntime(
    cwd: string,
    sessionManager: SessionManager,
    sessionStartEvent?: RuntimeStartEvent,
  ): Promise<AgentSessionRuntime> {
    return createAgentSessionRuntime(this.createRuntime, {
      cwd,
      agentDir: this.agentDir,
      sessionManager,
      sessionStartEvent,
    });
  }

  private async createPreparedRuntime(path: string): Promise<AgentSessionRuntime> {
    const startedAt = performance.now();
    const manager = SessionManager.open(path);
    let runtime: AgentSessionRuntime | undefined;
    this.prewarmManagers.add(manager);
    try {
      runtime = await this.createRootRuntime(
        manager.getCwd(),
        manager,
        { type: "session_start", reason: "resume", previousSessionFile: this.runtime?.session.sessionFile },
      );
      this.preboundSessions.add(runtime.session);
      await runtime.session.bindExtensions({ onError: (error) => this.fail(error) });
      this.log("runtime.prewarm.ready", basename(path));
      return runtime;
    } catch (error) {
      if (runtime) {
        try { await this.discardPreparedRuntime(runtime); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Runtime prewarm and cleanup failed");
        }
      }
      throw error;
    } finally {
      this.prewarmManagers.delete(manager);
      this.recordBackgroundLifecycle("prewarm", startedAt);
    }
  }

  private async clearPreparedRuntimes(): Promise<void> {
    if (this.prewarmTimer) clearTimeout(this.prewarmTimer);
    this.prewarmTimer = undefined;
    const prepared = [...this.prewarmedRuntimes.values()];
    this.prewarmedRuntimes.clear();
    const errors: unknown[] = [];
    for (const pending of prepared) {
      try {
        const runtime = await pending;
        if (runtime) await this.discardPreparedRuntime(runtime);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Prepared runtime cleanup failed");
  }

  private async discardPreparedRuntime(runtime: AgentSessionRuntime): Promise<void> {
    const session = runtime.session;
    try {
      if (this.preboundSessions.delete(session) && session.extensionRunner.hasHandlers("session_shutdown")) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      }
    } finally {
      session.dispose();
    }
  }

  private resolveProjectBranchInBackground(): void {
    if (this.branchResolution) return;
    const cwd = this.cwd;
    const startedAt = performance.now();
    const pending = this.resolveBranch(cwd).then((branch) => {
      if (this.cwd !== cwd) return;
      this.projectBranch = branch;
      this.emitUpdate({
        version: HOST_PROTOCOL_VERSION,
        type: "project",
        project: { cwd, branch },
      });
    }).catch((error) => this.fail(error)).finally(() => {
      this.recordBackgroundLifecycle("branch", startedAt);
      if (this.branchResolution === pending) this.branchResolution = undefined;
    });
    this.branchResolution = pending;
  }

  private queueRuntimeRetirement(runtime: AgentSessionRuntime, targetSessionFile: string): void {
    this.retirementQueue = this.retirementQueue.then(async () => {
      const startedAt = performance.now();
      try {
        const runner = runtime.session.extensionRunner;
        if (runner.hasHandlers("session_shutdown")) {
          await runner.emit({ type: "session_shutdown", reason: "resume", targetSessionFile });
        }
      } finally {
        runtime.session.dispose();
        this.recordBackgroundLifecycle("retire", startedAt);
      }
    }).catch((error) => this.fail(error));
  }

  private recordBackgroundLifecycle(name: string, startedAt: number): void {
    this.backgroundLifecycle.push({ name, durationMs: Math.round((performance.now() - startedAt) * 10) / 10 });
    if (this.backgroundLifecycle.length > 100) this.backgroundLifecycle.shift();
  }

  private scheduleRuntimePrewarm(): void {
    if (!this.automaticPrewarm || this.safeMode || this.prewarmTimer || this.prewarmedRuntimes.size >= 2) return;
    this.prewarmTimer = setTimeout(() => {
      this.prewarmTimer = undefined;
      const active = this.runtime?.session.sessionFile;
      const candidates = this.sessions
        .filter((session) => session.projectPath === this.cwd && session.path !== active && !this.prewarmedRuntimes.has(session.path))
        .slice(0, 2 - this.prewarmedRuntimes.size);
      for (const session of candidates) void this.prewarmSession(session.path);
    }, 1_000);
    this.prewarmTimer.unref?.();
  }

  private async activatePreparedRuntime(path: string, nextRuntime: AgentSessionRuntime): Promise<{ cancelled: boolean }> {
    const previous = this.requireRuntime();
    const runner = previous.session.extensionRunner;
    try {
      if (runner.hasHandlers("session_before_switch")) {
        const result = await runner.emit({ type: "session_before_switch", reason: "resume", targetSessionFile: path });
        if (result?.cancel === true) {
          await this.discardPreparedRuntime(nextRuntime);
          return { cancelled: true };
        }
      }
      await previous.session.abort();
    } catch (error) {
      await this.discardPreparedRuntime(nextRuntime);
      throw error;
    }

    this.invalidationCount += 1;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.resetSessionState();
    this.installRuntime(nextRuntime);
    try {
      const alreadyBound = this.preboundSessions.delete(nextRuntime.session);
      await this.bindSession(nextRuntime, nextRuntime.session, alreadyBound);
      this.queueRuntimeRetirement(previous, path);
      return { cancelled: false };
    } catch (error) {
      const cleanupErrors = await this.shutdownRuntime(nextRuntime);
      if (this.runtime === nextRuntime) this.runtime = undefined;
      this.installRuntime(previous);
      try {
        await this.bindSession(previous, previous.session, true);
      } catch (recoveryError) {
        throw new AggregateError([error, ...cleanupErrors, recoveryError], "Prewarmed runtime activation and recovery failed");
      }
      throw cleanupErrors.length > 0
        ? new AggregateError([error, ...cleanupErrors], "Prewarmed runtime activation failed")
        : error;
    }
  }

  private installRuntime(runtime: AgentSessionRuntime): void {
    this.runtime = runtime;
    this.cwd = runtime.cwd;
    runtime.setBeforeSessionInvalidate(() => {
      if (this.runtime !== runtime) return;
      this.invalidationCount += 1;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.resetSessionState();
    });
    runtime.setRebindSession(async (session) => {
      if (this.runtime !== runtime) throw new Error("Stale Pi runtime attempted to bind a session");
      await this.bindSession(runtime, session);
    });
  }

  private async swapRootRuntime(nextRuntime: AgentSessionRuntime): Promise<void> {
    const previous = this.runtime;
    const previousManager = previous?.session.sessionManager;
    const previousCwd = previous?.cwd;
    const teardownErrors = previous ? await this.shutdownRuntime(previous) : [];
    if (this.runtime === previous) this.runtime = undefined;
    for (const error of teardownErrors) this.fail(error);

    this.installRuntime(nextRuntime);
    try {
      await this.bindSession(nextRuntime, nextRuntime.session);
    } catch (error) {
      const cleanupErrors = await this.shutdownRuntime(nextRuntime);
      if (this.runtime === nextRuntime) this.runtime = undefined;
      if (previous && previousManager && previousCwd) {
        try {
          await this.recoverRuntime(previousCwd, previousManager, "workspace");
        } catch (recoveryError) {
          throw new AggregateError(
            [error, ...cleanupErrors, recoveryError],
            "Workspace replacement and recovery failed",
          );
        }
      }
      throw cleanupErrors.length > 0
        ? new AggregateError([error, ...cleanupErrors], "Workspace replacement failed")
        : error;
    }
  }

  private async bindSession(runtime: AgentSessionRuntime, session: AgentSession, alreadyBound = false): Promise<void> {
    if (runtime.session !== session) throw new Error("Cannot bind a stale Pi session");
    const bindStartedAt = performance.now();
    if (!alreadyBound) {
      await session.bindExtensions({
        onError: (error) => this.fail(error),
      });
    }
    this.logRuntimePhase(alreadyBound ? "bind-cache-hit" : "bind", bindStartedAt, "active", runtime.cwd);

    const catalogStartedAt = performance.now();
    const models = (await session.modelRuntime.getAvailable()).map(mapModel);
    this.logRuntimePhase("catalog", catalogStartedAt, "active", runtime.cwd);

    if (this.runtime !== runtime || runtime.session !== session) {
      throw new Error("Pi runtime changed while binding a session");
    }
    this.cwd = runtime.cwd;
    this.modelCatalogCache.set(this.resourceFingerprint(runtime.cwd), models);
    this.extensionCount = session.resourceLoader.getExtensions().extensions.length;
    this.unsubscribe?.();
    this.attachEvents(session);
    this.emitUpdate({
      version: HOST_PROTOCOL_VERSION,
      type: "catalog",
      catalog: {
        models,
        model: session.model ? mapModel(session.model) : undefined,
        thinkingLevel: session.thinkingLevel,
        thinkingLevels: session.getAvailableThinkingLevels(),
        allTools: session.getAllTools().map((tool) => ({ name: tool.name, description: tool.description })),
        extensionCount: this.extensionCount,
      },
    });
    this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd: runtime.cwd } });
    this.log("session.opened", session.sessionId.slice(0, 8));
  }

  private async replaceSession<T extends { cancelled: boolean }>(
    reason: string,
    replace: (runtime: AgentSessionRuntime) => Promise<T>,
  ): Promise<T> {
    const runtime = this.requireRuntime();
    const previousSession = runtime.session;
    const previousManager = previousSession.sessionManager;
    const previousCwd = runtime.cwd;
    const invalidationCount = this.invalidationCount;
    try {
      return await replace(runtime);
    } catch (error) {
      this.log("runtime.replace.failed", `${reason} · ${this.errorMessage(error)}`);
      if (this.invalidationCount === invalidationCount) throw error;

      const cleanupErrors = runtime.session !== previousSession
        ? await this.shutdownRuntime(runtime)
        : [];
      if (this.runtime === runtime) this.runtime = undefined;
      try {
        await this.recoverRuntime(previousCwd, previousManager, reason);
      } catch (recoveryError) {
        this.runtime = undefined;
        throw new AggregateError(
          [error, ...cleanupErrors, recoveryError],
          `Pi runtime ${reason} and recovery failed`,
        );
      }
      throw error;
    }
  }

  private async recoverRuntime(cwd: string, manager: SessionManager, reason: string): Promise<void> {
    const recovered = await this.createRootRuntime(
      cwd,
      manager,
      { type: "session_start", reason: "reload", previousSessionFile: manager.getSessionFile() },
    );
    this.installRuntime(recovered);
    try {
      await this.bindSession(recovered, recovered.session);
      this.log("runtime.recovered", reason);
    } catch (error) {
      const cleanupErrors = await this.shutdownRuntime(recovered);
      if (this.runtime === recovered) this.runtime = undefined;
      throw cleanupErrors.length > 0
        ? new AggregateError([error, ...cleanupErrors], "Pi runtime recovery failed")
        : error;
    }
  }

  private async shutdownRuntime(runtime: AgentSessionRuntime): Promise<unknown[]> {
    const errors: unknown[] = [];
    try {
      await runtime.session.abort();
    } catch (error) {
      errors.push(error);
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
    if (this.runtime === runtime) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.resetSessionState();
    }
    return errors;
  }

  private runLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleQueue.then(operation);
    this.lifecycleQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private attachEvents(session: AgentSession): void {
    this.unsubscribe = session.subscribe((event) => {
      switch (event.type) {
        case "agent_start":
          this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "run", event: "started", sessionId: session.sessionId });
          this.emit({ type: "agent-status", sessionId: session.sessionId, running: true });
          this.log("agent.started");
          break;
        case "agent_end":
          this.log("agent.ended", `${event.messages.length} messages`);
          break;
        case "agent_settled":
          this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "run", event: "settled", sessionId: session.sessionId });
          this.emit({ type: "agent-status", sessionId: session.sessionId, running: false });
          this.log("agent.settled");
          break;
        case "message_start":
          if (event.message.role === "assistant") {
            this.currentAssistantId = `assistant-live-${event.message.timestamp}`;
            this.emit({
              type: "assistant-start",
              id: this.currentAssistantId,
              timestamp: event.message.timestamp,
            });
          }
          break;
        case "message_update": {
          const update = event.assistantMessageEvent;
          if (!this.currentAssistantId) break;
          if (update.type === "text_delta") {
            this.emit({ type: "assistant-delta", id: this.currentAssistantId, delta: update.delta });
          } else if (update.type === "thinking_delta") {
            this.emit({ type: "assistant-thinking", id: this.currentAssistantId, delta: update.delta });
          }
          break;
        }
        case "message_end":
          if (event.message.role === "assistant") {
            const message = mapMessage(event.message, 0);
            if (message) {
              message.id = this.currentAssistantId ?? message.id;
              this.emit({ type: "assistant-end", message });
            }
            this.currentAssistantId = undefined;
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
          this.tools.set(tool.id, tool);
          this.emit({ type: "tool-start", tool });
          this.log("tool.started", event.toolName);
          break;
        }
        case "tool_execution_update": {
          const output = boundedToolOutput(resultText(event.partialResult));
          const previous = this.tools.get(event.toolCallId);
          if (previous) this.tools.set(event.toolCallId, { ...previous, output });
          this.toolOutputBatcher.push(event.toolCallId, output);
          break;
        }
        case "tool_execution_end": {
          // Never let a delayed batch arrive after the terminal event.
          this.toolOutputBatcher.flushId(event.toolCallId);
          const previous = this.tools.get(event.toolCallId);
          const tool: UiToolRun = {
            id: event.toolCallId,
            name: event.toolName,
            args: (previous?.args ?? {}) as Record<string, unknown>,
            status: event.isError ? "error" : "done",
            output: boundedToolOutput(resultText(event.result)),
            startedAt: previous?.startedAt ?? Date.now(),
            endedAt: Date.now(),
          };
          this.tools.set(tool.id, tool);
          this.invalidateGitAfterTool(tool);
          this.emit({ type: "tool-end", tool });
          // Settled output belongs to the renderer/artifact store, not the host's
          // active-run map. Do not retain every completed tool forever.
          this.tools.delete(tool.id);
          this.log("tool.ended", `${event.toolName}:${tool.status}`);
          break;
        }
        case "queue_update":
          this.emit({ type: "queue", steering: [...event.steering], followUp: [...event.followUp] });
          break;
      }
    });
  }

  private async ensureModels(): Promise<UiModel[]> {
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

  private async refreshThreadIndex(publish: boolean): Promise<ThreadIndexSnapshot> {
    if (!this.threadIndexRefresh) {
      const scanStartedAt = Date.now();
      this.threadIndexRefresh = (async () => {
        const sessionInfos = await SessionManager.listAll();
        const scanned = await mapSessions(sessionInfos, this.cwd, (cwd) => this.resolveBranch(cwd));
        this.sessions = mergeSessionIndexScan(scanned, this.sessions, scanStartedAt);
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
    const scanned = await mapSessions(sessionInfos, this.cwd, (cwd) => this.resolveBranch(cwd));
    const next = mergeSessionIndexScan(scanned, this.sessions, scanStartedAt);
    this.sessions = next;
    for (const update of sessionIndexUpdates(previous, next)) this.emitUpdate(update);
  }

  /** Prompt completion updates one shell; the global scan is a startup/recovery path. */
  private async refreshActiveThreadIndex(): Promise<void> {
    const session = this.runtime?.session;
    if (!session) return;
    const projectPath = this.cwd;
    const shell: UiSession = {
      id: session.sessionId,
      path: session.sessionFile ?? session.sessionManager.getSessionFile() ?? session.sessionId,
      title: session.sessionName || firstSentence(textFromContent(session.messages.find((message) => message.role === "user")?.content)),
      modifiedAt: Date.now(),
      projectPath,
      projectName: basename(projectPath) || projectPath,
      branch: await this.resolveBranch(projectPath),
      messageCount: session.messages.length,
    };
    this.sessions = [shell, ...this.sessions.filter((item) => item.id !== shell.id)];
    this.publishThreadShellSoon(shell);
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
      if (knownPaths.has(thread.projectPath)) continue;
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

  private messageSnapshot(): UiMessage[] {
    return this.requireSession().messages
      .map((message, index) => mapMessage(message, index))
      .filter((message): message is UiMessage => Boolean(message?.text));
  }

  private snapshotSync(models: UiModel[]): HostSnapshot {
    const session = this.requireSession();
    const firstUserMessage = session.messages.find((message) => message.role === "user");
    const usage = session.getContextUsage();
    return {
      cwd: this.cwd,
      sessionId: session.sessionId,
      sessionName: session.sessionName,
      sessionTitle: session.sessionName || firstSentence(firstUserMessage ? textFromContent(firstUserMessage.content) : ""),
      model: session.model ? mapModel(session.model) : undefined,
      models,
      thinkingLevel: session.thinkingLevel,
      thinkingLevels: session.getAvailableThinkingLevels(),
      messages: this.messageSnapshot(),
      isStreaming: session.isStreaming,
      activeTools: session.getActiveToolNames(),
      allTools: session.getAllTools().map((tool) => ({ name: tool.name, description: tool.description })),
      extensionCount: this.extensionCount,
      contextUsage: usage && usage.tokens !== null && usage.percent !== null
        ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
        : undefined,
    };
  }

  private requestApproval(
    toolCallId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<AccessDecision> {
    const id = `${toolCallId}-${(this.approvalCounter += 1)}`;
    return new Promise<AccessDecision>((resolve) => {
      let settled = false;
      const settle = (decision: AccessDecision) => {
        if (settled) return;
        settled = true;
        this.pendingApprovals.delete(id);
        clearTimeout(timer);
        resolve(decision);
      };
      // An unanswered prompt must not hold the agent open forever.
      const timer = setTimeout(
        () => settle({ allowed: false, reason: "Blocked by Tau: the approval request timed out." }),
        5 * 60_000,
      );
      timer.unref?.();
      this.pendingApprovals.set(id, settle);
      this.emit({
        type: "tool-approval",
        request: { id, toolName, summary: approvalSummary(toolName, input) },
      });
    });
  }

  private settleAllApprovals(decision: AccessDecision): void {
    const pending = [...this.pendingApprovals.values()];
    this.pendingApprovals.clear();
    pending.forEach((settle) => settle(decision));
  }

  private resolveBranch(cwd: string): Promise<string | undefined> {
    return this.gitCoordinator.getBranch(cwd);
  }

  private invalidateGitAfterTool(tool: UiToolRun): void {
    const command = typeof tool.args.command === "string" ? tool.args.command : "";
    const mutatesGit = /\bgit\s+(?:checkout|switch|branch|reset|worktree|commit|merge|rebase|pull|fetch)\b/iu.test(command);
    if (tool.name === "edit" || tool.name === "write" || mutatesGit) {
      this.gitCoordinator.invalidate(this.cwd, mutatesGit
        ? ["status", "branch", "workspace"]
        : ["status", "workspace"]);
    }
  }

  private resetSessionState(): void {
    this.tools.clear();
    this.currentAssistantId = undefined;
  }

  private requireRuntime(): AgentSessionRuntime {
    if (!this.runtime) throw new Error("Pi runtime is not ready");
    return this.runtime;
  }

  private requireSession(): AgentSession {
    return this.requireRuntime().session;
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
