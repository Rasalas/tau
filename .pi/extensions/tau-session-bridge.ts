import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatChatTranscript } from "../../src/shared/chat-transcript.js";
import { taskProgressFromMessages, taskProgressHistoryFromMessages } from "../../src/shared/task-progress.js";
import type { DiffLoadOptions, UiFileDiff } from "../../src/shared/contracts.js";
import * as workspaceGit from "../../src/main/workspace-git.js";
import { assistantAnchorForMessage, createPiTurnCheckpointExtension } from "../../src/main/pi-turn-checkpoint-extension.js";
import { pageRecords } from "../../src/shared/transcript-pager.js";
import {
  boundedTurnCheckpointSummary,
  summariesFromStoredTurnCheckpoints,
  TURN_CHECKPOINT_CUSTOM_TYPE,
  turnCheckpointsFromEntries,
  TurnCheckpointLifecycle,
  type StoredTurnCheckpoint,
} from "../../src/shared/turn-checkpoints.js";
import {
  encodePiBridgeFrame,
  PI_BRIDGE_MAX_FRAME_BYTES,
  PI_BRIDGE_PROTOCOL_VERSION,
  type PiBridgeClientFrame,
  type PiBridgeDescriptor,
  type PiBridgeServerFrame,
  type PiBridgeAwaitingInput,
  type PiBridgeSnapshot,
  type PiBridgeTurnFilesPage,
} from "../../src/shared/pi-bridge-protocol.js";

interface ClientState { socket: Socket; authenticated: boolean; buffer: string }

function boundedBridgeValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "string") return item;
    const bytes = Buffer.from(item, "utf8");
    if (bytes.length <= 32 * 1024) return item;
    return `${bytes.subarray(0, 32 * 1024).toString("utf8")}\n[Bridge value truncated from ${bytes.length} bytes]`;
  })) as T;
}

function isUserRecord(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { role?: unknown }).role === "user");
}

/** Records that map to transcript rows. Tool results stay in activityMessages. */
function isTranscriptRecord(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const role = (value as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "custom";
}

function bridgeTranscriptPage(records: readonly unknown[], cursor?: string) {
  const visibleRecords = records.filter(isTranscriptRecord);
  const page = pageRecords(visibleRecords, 40, cursor, isUserRecord);
  const end = cursor === undefined ? visibleRecords.length : Number(cursor);
  const start = end - page.messages.length;
  const rawIndices = records.flatMap((record, index) => isTranscriptRecord(record) ? [index] : []);
  const rawStart = rawIndices[start] ?? records.length;
  const rawEnd = rawIndices[end] ?? records.length;
  return {
    page,
    activityMessages: records.slice(rawStart, rawEnd),
  };
}

export default function tauSessionBridge(pi: ExtensionAPI) {
  pi.registerCommand("tau-bridge-reload", {
    description: "Reload Pi resources for an attached Tau client",
    handler: async (_args, ctx) => ctx.reload(),
  });
  pi.registerCommand("tau-bridge-new", {
    description: "Create a new Pi session for an attached Tau client",
    handler: async (args, ctx) => {
      const initialPrompt = args ? JSON.parse(Buffer.from(args, "base64url").toString("utf8")) as string : undefined;
      await ctx.newSession({
        ...(initialPrompt ? { withSession: async (fresh) => {
          await fresh.sendUserMessage(initialPrompt);
        } } : {}),
      });
    },
  });
  pi.registerCommand("tau-bridge-fork", {
    description: "Fork the active Pi session for an attached Tau client",
    handler: async (entryId, ctx) => {
      if (!ctx.sessionManager.getBranch().some((entry) => entry.id === entryId)) {
        ctx.ui.notify("The selected message is no longer on the active branch.", "error");
        return;
      }
      await ctx.fork(entryId, { position: "at" });
    },
  });

  let server: Server | undefined;
  let descriptor: PiBridgeDescriptor | undefined;
  let latestContext: ExtensionContext | undefined;
  // A checkpoint may finish after Pi has already switched to another session.
  // Keep the owning context by session/turn so background Git work can still
  // append to the correct session instead of following the mutable tail.
  const sessionContexts = new Map<string, ExtensionContext>();
  const turnContexts = new Map<string, ExtensionContext>();
  /**
   * Pi owns its own UI context while it owns the runtime, so an extension cannot
   * intercept another extension's question — it is answered in Pi's terminal.
   * What Tau can be told is that the thread is stalled on one.
   */
  let awaitingInput: PiBridgeAwaitingInput | undefined;
  let sequence = 0;
  const clients = new Set<ClientState>();
  const contextForTurn = (turnId: string): ExtensionContext | undefined => turnContexts.get(turnId) ?? latestContext;
  const contextForNewTurn = (turnId: string): ExtensionContext | undefined => turnContexts.get(turnId) ?? latestContext;
  const currentContext = (ctx: ExtensionContext): boolean => Boolean(descriptor
    && descriptor.sessionId === ctx.sessionManager.getSessionId());
  const checkpointLifecycle = new TurnCheckpointLifecycle<workspaceGit.WorkspaceSnapshot>({
    createBefore: (turnId) => {
      const ctx = contextForNewTurn(turnId);
      if (!ctx) return Promise.resolve(undefined);
      const sessionId = ctx.sessionManager.getSessionId();
      sessionContexts.set(sessionId, ctx);
      turnContexts.set(turnId, ctx);
      return workspaceGit.createTurnWorkspaceSnapshot(ctx.cwd, sessionId, turnId, "before");
    },
    createAfter: (turnId) => {
      const ctx = contextForTurn(turnId);
      if (!ctx) return Promise.resolve(undefined);
      const sessionId = ctx.sessionManager.getSessionId();
      sessionContexts.set(sessionId, ctx);
      turnContexts.set(turnId, ctx);
      return workspaceGit.createTurnWorkspaceSnapshot(ctx.cwd, sessionId, turnId, "after");
    },
    summarize: (before, after, turnId) => {
      const sessionId = before.sessionId;
      const ctx = sessionId ? sessionContexts.get(sessionId) : undefined;
      if (!ctx || before.cwd !== after.cwd || before.sessionId !== after.sessionId
        || before.turnId !== turnId || after.turnId !== turnId) {
        return Promise.reject(new Error("Pi session snapshot ownership changed."));
      }
      return workspaceGit.diffWorkspaceSnapshots(ctx.cwd, before.id, after.id, {
        expected: { sessionId, turnId },
      });
    },
    discardSnapshot: (snapshot) => {
      const ctx = latestContext;
      const snapshotCwd = snapshot.cwd ?? ctx?.cwd;
      if (!snapshotCwd) return;
      return workspaceGit.deleteWorkspaceSnapshot(
        snapshotCwd,
        snapshot.id,
        snapshot.sessionId && snapshot.turnId && snapshot.phase
          ? { sessionId: snapshot.sessionId, turnId: snapshot.turnId, phase: snapshot.phase, treeId: snapshot.treeId }
          : undefined,
      );
    },
    persist: async (result, capture) => {
      const sessionId = result.beforeSnapshot.sessionId;
      const ctx = sessionId ? sessionContexts.get(sessionId) : undefined;
      if (!ctx) throw new Error("Pi session is unavailable.");
      if (result.afterSnapshot.sessionId !== sessionId || result.beforeSnapshot.turnId !== capture.id
        || result.afterSnapshot.turnId !== capture.id) {
        throw new Error("Pi session snapshot ownership changed.");
      }
      const summary = boundedTurnCheckpointSummary(result.changes);
      const stored: StoredTurnCheckpoint = {
        id: capture.id,
        turnId: capture.id,
        sessionId,
        anchorMessageId: result.anchorMessageId,
        beforeSnapshotId: result.beforeSnapshot.id,
        afterSnapshotId: result.afterSnapshot.id,
        startedAt: capture.startedAt,
        endedAt: result.endedAt,
        ...summary,
      };
      try {
        if (turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), sessionId).some((entry) => entry.id === stored.id)) return;
        ctx.sessionManager.appendCustomEntry(TURN_CHECKPOINT_CUSTOM_TYPE, stored);
        if (!currentContext(ctx)) return;
        broadcast({ type: "turn-checkpoint", checkpoint: summariesFromStoredTurnCheckpoints([stored])[0] }, ctx);
        // The checkpoint may anchor an otherwise empty assistant message. A
        // bounded snapshot re-announces that exact raw entry so the renderer can
        // retain the anchor instead of inventing a tail activity row.
        broadcastSnapshot(ctx);
      } finally {
        turnContexts.delete(capture.id);
      }
    },
    onError: (error, capture) => {
      const ctx = contextForTurn(capture.id);
      turnContexts.delete(capture.id);
      if (ctx && currentContext(ctx)) broadcast({ type: "turn-checkpoint-error", turnId: capture.id, message: String(error) }, ctx);
    },
  });

  const historicalDiff = async (ctx: ExtensionContext, checkpointId: string, path: string, options?: DiffLoadOptions): Promise<UiFileDiff> => {
    const checkpoint = turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId())
      .find((entry) => entry.id === checkpointId);
    if (!checkpoint) return { path, added: 0, removed: 0, hunks: [], note: "This turn checkpoint is no longer available." };
    await workspaceGit.assertWorkspacePath(ctx.cwd, path);
    const diff = await workspaceGit.getSnapshotFileDiff(
      ctx.cwd,
      checkpoint.beforeSnapshotId,
      checkpoint.afterSnapshotId,
      path,
      options,
      { sessionId: checkpoint.sessionId, turnId: checkpoint.turnId },
    );
    return diff;
  };

  const historicalFiles = async (ctx: ExtensionContext, checkpointId: string, cursor?: string, limit?: number): Promise<PiBridgeTurnFilesPage> => {
    const checkpoint = turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId())
      .find((entry) => entry.id === checkpointId);
    if (!checkpoint) throw new Error("This turn checkpoint is no longer available.");
    const page = await workspaceGit.diffWorkspaceSnapshotPage(ctx.cwd, checkpoint.beforeSnapshotId, checkpoint.afterSnapshotId, {
      sessionId: checkpoint.sessionId,
      turnId: checkpoint.turnId,
      cursor,
      limit,
    });
    return boundedBridgeValue({ ...page, sessionId: checkpoint.sessionId, checkpointId });
  };

  const send = (client: ClientState, frame: PiBridgeServerFrame) => {
    if (!client.socket.destroyed) client.socket.write(encodePiBridgeFrame(frame));
  };

  const branchMessages = (ctx: ExtensionContext): unknown[] => ctx.sessionManager.getBranch()
    .flatMap((entry) => entry.type === "message" ? [{ ...entry.message, tauEntryId: entry.id }] : []);

  const checkpointsForRawMessages = (ctx: ExtensionContext, messages: readonly unknown[]) => {
    const ids = new Set(messages.flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const id = (message as { tauEntryId?: unknown }).tauEntryId;
      return typeof id === "string" ? [id] : [];
    }));
    return summariesFromStoredTurnCheckpoints(
      turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId())
        .filter((checkpoint) => ids.has(checkpoint.anchorMessageId)),
    );
  };

  const snapshot = (ctx: ExtensionContext): PiBridgeSnapshot => {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) throw new Error("Tau bridge requires a persisted Pi session.");
    const usage = ctx.getContextUsage();
    const messages = branchMessages(ctx);
    // Use the exact same turn pager as `transcript_page`. The cursor therefore
    // points immediately before the mapped transcript records exposed here;
    // tool-result records are carried separately for completed activity.
    const initialPage = bridgeTranscriptPage(messages);
    const visibleMessages = initialPage.page.messages;
    const olderCursor = initialPage.page.olderCursor;
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: file,
      cwd: ctx.cwd,
      sessionName: pi.getSessionName(),
      messages: boundedBridgeValue(visibleMessages),
      activityMessages: boundedBridgeValue(initialPage.activityMessages),
      ...(olderCursor ? { olderCursor } : {}),
      isStreaming: !ctx.isIdle(),
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name } : undefined,
      models: ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id, name: model.name })),
      thinkingLevel: pi.getThinkingLevel(),
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      activeTools: pi.getActiveTools(),
      allTools: pi.getAllTools().map((tool) => ({ name: tool.name, description: tool.description })),
      // A snapshot exposes only the bounded raw tail; never attach older cards
      // to this newest page. Older cards travel with their own transcript page.
      turnCheckpoints: checkpointsForRawMessages(ctx, visibleMessages),
      composerCommands: pi.getCommands()
        .filter((command) => !command.name.startsWith("tau-bridge-"))
        .map((command) => ({
          name: command.name,
          description: command.description,
          source: command.source,
        })),
      contextUsage: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : undefined,
      taskProgress: taskProgressFromMessages(messages),
      taskHistory: taskProgressHistoryFromMessages(messages),
      awaitingInput,
    };
  };

  const broadcast = (event: unknown, ctx: ExtensionContext) => {
    if (!currentContext(ctx)) return;
    latestContext = ctx;
    if (!descriptor) return;
    const frame: PiBridgeServerFrame = {
      protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
      type: "event",
      epoch: descriptor.epoch,
      seq: ++sequence,
      sessionId: descriptor.sessionId,
      event: boundedBridgeValue(event),
    };
    for (const client of clients) if (client.authenticated) send(client, frame);
  };

  const broadcastSnapshot = (ctx: ExtensionContext) => {
    if (!currentContext(ctx)) return;
    const frame: PiBridgeServerFrame = {
      protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
      type: "snapshot",
      epoch: descriptor.epoch,
      seq: ++sequence,
      snapshot: snapshot(ctx),
    };
    for (const client of clients) if (client.authenticated) send(client, frame);
  };

  const respond = (client: ClientState, id: string, ok: boolean, result?: unknown) => {
    if (!descriptor) return;
    send(client, ok
      ? { protocolVersion: PI_BRIDGE_PROTOCOL_VERSION, type: "response", id, epoch: descriptor.epoch, ok: true, result }
      : { protocolVersion: PI_BRIDGE_PROTOCOL_VERSION, type: "response", id, epoch: descriptor.epoch, ok: false, error: String(result) });
  };

  const handleFrame = async (client: ClientState, frame: PiBridgeClientFrame) => {
    if (!descriptor || frame.protocolVersion !== PI_BRIDGE_PROTOCOL_VERSION || frame.epoch !== descriptor.epoch) {
      client.socket.destroy();
      return;
    }
    if (!client.authenticated) {
      if (frame.type !== "hello" || frame.token !== descriptor.token || frame.expectedSessionId !== descriptor.sessionId) {
        client.socket.destroy();
        return;
      }
      client.authenticated = true;
      const ctx = latestContext;
      if (!ctx) return client.socket.destroy();
      send(client, {
        protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
        type: "ready",
        id: frame.id,
        epoch: descriptor.epoch,
        snapshot: snapshot(ctx),
      });
      return;
    }
    if (frame.type !== "command" || frame.expectedSessionId !== descriptor.sessionId) {
      client.socket.destroy();
      return;
    }
    const ctx = latestContext;
    if (!ctx) return respond(client, frame.id, false, "Pi session is unavailable.");
    const responseId = frame.id;
    try {
      switch (frame.command) {
        case "ping": respond(client, frame.id, true, { now: Date.now() }); break;
        case "snapshot": respond(client, frame.id, true, snapshot(ctx)); break;
        case "prompt":
          // Do not infer the boundary from `ctx.isIdle()`: a second command can
          // arrive while the first prompt is still in its async input hook. Pi's
          // shared input/turn_start adapter assigns each accepted client turn at
          // its actual delivery boundary.
          if (typeof frame.clientTurnId !== "string" || frame.clientTurnId.length === 0) {
            throw new Error("A client turn id is required for a prompt.");
          }
          const queued = !ctx.isIdle();
          const commandName = frame.text.startsWith("/") ? frame.text.slice(1).split(/\s+/u, 1)[0] : "";
          const handledCommand = Boolean(commandName && pi.getCommands().some((command) =>
            command.name === commandName && command.source === "extension"));
          if (!handledCommand) {
            // Bind the accepted client turn before its deferred Git operation can
            // run. A session switch between queueing and delivery must not move
            // its before snapshot onto the new session's workspace.
            turnContexts.set(frame.clientTurnId, ctx);
            sessionContexts.set(ctx.sessionManager.getSessionId(), ctx);
            checkpointLifecycle.acceptUserTurn(frame.clientTurnId, { deferBefore: true });
          }
          void pi.sendUserMessage(frame.text, {
            ...(queued ? { deliverAs: frame.deliverAs ?? "followUp" } : {}),
            expandPromptTemplates: true,
          }).then(async () => {
            // Extension commands are handled before Pi emits `input`; they are
            // accepted by the bridge command but are not user turns.
            if (handledCommand || (!queued && checkpointLifecycle.get(frame.clientTurnId)?.started !== true)) {
              await checkpointLifecycle.reject(frame.clientTurnId);
            }
          }).catch(async (error) => {
            await checkpointLifecycle.reject(frame.clientTurnId);
            if (latestContext) broadcast({ type: "turn-checkpoint-error", turnId: frame.clientTurnId, message: String(error) }, latestContext);
          });
          respond(client, frame.id, true, { accepted: true });
          break;
        case "abort": ctx.abort(); respond(client, frame.id, true); break;
        case "set_thinking": pi.setThinkingLevel(frame.level as Parameters<typeof pi.setThinkingLevel>[0]); respond(client, frame.id, true); break;
        case "set_model": {
          const model = ctx.modelRegistry.find(frame.provider, frame.id);
          if (!model || !(await pi.setModel(model))) throw new Error("Model is unavailable or not authenticated.");
          respond(client, frame.id, true);
          break;
        }
        case "compact": ctx.compact({ onComplete: () => broadcastSnapshot(ctx) }); respond(client, frame.id, true); break;
        case "reload":
          if (!ctx.isIdle()) throw new Error("Wait for the active run before reloading Pi.");
          respond(client, frame.id, true, { accepted: true });
          setTimeout(() => pi.sendUserMessage("/tau-bridge-reload", { expandPromptTemplates: true }), 0);
          break;
        case "set_session_name": pi.setSessionName(frame.name); respond(client, frame.id, true); break;
        case "transcript_page": {
          const records = branchMessages(ctx);
          const page = bridgeTranscriptPage(records, frame.cursor).page;
          respond(client, frame.id, true, {
            sessionId: ctx.sessionManager.getSessionId(),
            ...boundedBridgeValue(page),
            turnCheckpoints: checkpointsForRawMessages(ctx, page.messages),
          });
          break;
        }
        case "export_markdown": {
          const messages = ctx.sessionManager.getBranch()
            .flatMap((entry) => entry.type === "message" ? [entry.message] : []);
          const markdown = formatChatTranscript({
            title: pi.getSessionName(),
            cwd: ctx.cwd,
            sessionId: ctx.sessionManager.getSessionId(),
            messages,
          });
          if (Buffer.byteLength(markdown, "utf8") > PI_BRIDGE_MAX_FRAME_BYTES - 1024) {
            throw new Error("This thread is too large to copy through the Tau bridge.");
          }
          respond(client, frame.id, true, { markdown });
          break;
        }
        case "turn_file_diff":
          respond(client, frame.id, true, await historicalDiff(ctx, frame.checkpointId, frame.path, frame));
          break;
        case "turn_files_page":
          respond(client, frame.id, true, await historicalFiles(ctx, frame.checkpointId, frame.cursor, frame.limit));
          break;
        case "new_session": {
          if (!ctx.isIdle()) throw new Error("Wait for the active run before creating a new thread.");
          respond(client, frame.id, true, { accepted: true });
          setTimeout(() => {
            const encodedPrompt = frame.initialPrompt
              ? ` ${Buffer.from(JSON.stringify(frame.initialPrompt), "utf8").toString("base64url")}`
              : "";
            pi.sendUserMessage(`/tau-bridge-new${encodedPrompt}`, { expandPromptTemplates: true });
          }, 0);
          break;
        }
        case "fork": {
          if (!ctx.isIdle()) throw new Error("Wait for the active run before forking this thread.");
          if (!ctx.sessionManager.getBranch().some((entry) => entry.id === frame.entryId)) {
            throw new Error("The selected message is no longer on the active branch.");
          }
          respond(client, frame.id, true, { accepted: true });
          setTimeout(() => {
            pi.sendUserMessage(`/tau-bridge-fork ${frame.entryId}`, { expandPromptTemplates: true });
          }, 0);
          break;
        }
        default:
          respond(client, responseId, false, `Unsupported Pi bridge command. Reload Pi to update the Tau bridge (protocol ${PI_BRIDGE_PROTOCOL_VERSION}).`);
      }
    } catch (error) {
      respond(client, frame.id, false, error instanceof Error ? error.message : String(error));
    }
  };

  const stop = async () => {
    const closing = descriptor;
    descriptor = undefined;
    latestContext = undefined;
    for (const client of clients) client.socket.destroy();
    clients.clear();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    if (closing) {
      if (process.platform !== "win32") await rm(closing.socketPath, { force: true }).catch(() => undefined);
      const descriptorPath = join(getAgentDir(), "tau-bridge", "sessions", `${closing.sessionId}.json`);
      try {
        const current = JSON.parse(await readFile(descriptorPath, "utf8")) as { epoch?: string };
        if (current.epoch === closing.epoch) await rm(descriptorPath, { force: true });
      } catch { /* already gone */ }
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    // Settlement starts the old session's snapshot/summary writes but does not
    // hold Pi's session-switch lifecycle open. The adapter keeps the owning
    // session context, so those writes cannot drift onto the new session.
    await checkpointLifecycle.settle();
    await stop();
    if (ctx.mode !== "tui") return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    latestContext = ctx;
    sequence = 0;
    const epoch = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const suffix = createHash("sha256").update(`${ctx.sessionManager.getSessionId()}:${epoch}`).digest("hex").slice(0, 20);
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\tau-pi-${process.env.USERNAME ?? "user"}-${suffix}`
      : join(tmpdir(), `tau-pi-${process.getuid?.() ?? "user"}-${suffix}.sock`);
    if (process.platform !== "win32") await rm(socketPath, { force: true }).catch(() => undefined);
    server = createServer((socket) => {
      const client: ClientState = { socket, authenticated: false, buffer: "" };
      clients.add(client);
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        client.buffer += chunk;
        if (Buffer.byteLength(client.buffer, "utf8") > PI_BRIDGE_MAX_FRAME_BYTES) return socket.destroy();
        for (;;) {
          const newline = client.buffer.indexOf("\n");
          if (newline < 0) break;
          const line = client.buffer.slice(0, newline);
          client.buffer = client.buffer.slice(newline + 1);
          if (!line) continue;
          try { void handleFrame(client, JSON.parse(line) as PiBridgeClientFrame); }
          catch { socket.destroy(); }
        }
      });
      socket.on("close", () => clients.delete(client));
      socket.on("error", () => clients.delete(client));
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socketPath, () => { server!.off("error", reject); resolve(); });
    });
    const descriptorDir = join(getAgentDir(), "tau-bridge", "sessions");
    await mkdir(descriptorDir, { recursive: true, mode: 0o700 });
    await chmod(descriptorDir, 0o700);
    descriptor = {
      protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
      epoch,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile,
      cwd: ctx.cwd,
      pid: process.pid,
      socketPath,
      token,
      startedAt: Date.now(),
    };
    const descriptorPath = join(descriptorDir, `${descriptor.sessionId}.json`);
    const tempPath = join(dirname(descriptorPath), `.${descriptor.sessionId}.${epoch}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, descriptorPath);
  });

  const onAny = pi.on as unknown as (
    eventName: string,
    handler: (event: Record<string, unknown>, ctx: ExtensionContext) => void | Promise<void>,
  ) => void;
  createPiTurnCheckpointExtension({
    lifecycle: checkpointLifecycle,
    nextTurnId: randomUUID,
    findAssistantAnchor: assistantAnchorForMessage,
  })(pi);
  for (const eventName of [
    "agent_start", "agent_end", "agent_settled", "turn_start", "turn_end", "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end", "queue_update", "model_select",
    "thinking_level_select", "ui_prompt_start", "ui_prompt_end",
  ] as const) onAny(eventName, async (event, ctx) => {
    broadcast({ ...event, type: eventName }, ctx);
    if (eventName === "message_end" || eventName === "agent_settled" || eventName === "model_select" || eventName === "thinking_level_select") {
      broadcastSnapshot(ctx);
    }
  });

  pi.on("session_info_changed", (event, ctx) => { broadcast({ ...event, type: "session_info_changed" }, ctx); broadcastSnapshot(ctx); });
  // Pi blocks here until the question in its terminal is answered. Tau cannot
  // answer it, but it can stop pretending the thread is merely "working".
  pi.on("ui_prompt_start", (event, ctx) => {
    awaitingInput = { kind: event.kind as PiBridgeAwaitingInput["kind"], title: event.title };
    broadcastSnapshot(ctx);
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    awaitingInput = undefined;
    broadcastSnapshot(ctx);
  });
  pi.on("session_shutdown", async () => {
    await checkpointLifecycle.close();
    await stop();
  });
}
