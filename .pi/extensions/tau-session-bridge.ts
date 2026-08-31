import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatChatTranscript } from "../../src/shared/chat-transcript.js";
import { taskProgressFromMessages, taskProgressHistoryFromMessages } from "../../src/shared/task-progress.js";
import type { DiffLoadOptions, UiFileDiff } from "../../src/shared/contracts.js";
import * as workspaceGit from "../../src/main/workspace-git.js";
import { WorkspaceCheckpointLeaseManager } from "../../src/main/workspace-checkpoint-lease.js";
import { assistantAnchorForMessage, createPiTurnCheckpointExtension } from "../../src/main/pi-turn-checkpoint-extension.js";
import {
  checkpointsForBranch,
  cloneTurnCheckpoint,
  rehomeStoredTurnCheckpoint,
  TURN_CHECKPOINT_CUSTOM_TYPE,
  turnCheckpointsFromEntries,
  turnSnapshotRef,
} from "../../src/shared/turn-checkpoint-codec.js";
import { TurnCheckpointLifecycle } from "../../src/shared/turn-checkpoint-lifecycle.js";
import { createTurnCheckpointAdapter } from "../../src/shared/turn-checkpoint-adapter.js";
import { bridgeTranscriptPage, boundedBridgePayload, boundedBridgeValue } from "../../src/shared/bridge-transcript-pager.js";
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

const MAX_BRIDGE_CATALOG_ITEMS = 64;
const MAX_BRIDGE_CATALOG_TEXT = 8 * 1024;

function boundedCatalogText(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length <= MAX_BRIDGE_CATALOG_TEXT
    ? text
    : `${text.slice(0, MAX_BRIDGE_CATALOG_TEXT)}\n[Bridge catalog text truncated]`;
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
  const checkpointLeaseManager = new WorkspaceCheckpointLeaseManager();
  let previousSessionForFork: {
    context: ExtensionContext;
    sessionId: string;
    cwd: string;
    checkpoints: ReturnType<typeof turnCheckpointsFromEntries>;
  } | undefined;
  /**
   * Pi owns its own UI context while it owns the runtime, so an extension cannot
   * intercept another extension's question — it is answered in Pi's terminal.
   * What Tau can be told is that the thread is stalled on one.
   */
  let awaitingInput: PiBridgeAwaitingInput | undefined;
  let sequence = 0;
  const clients = new Set<ClientState>();
  // A turn is attributed to the context that accepted its client id. Falling
  // back to the mutable session tail would make a switch during a queued turn
  // attach its refs or checkpoint entry to the wrong session.
  const contextForTurn = (turnId: string): ExtensionContext | undefined => turnContexts.get(turnId);
  const contextForNewTurn = (turnId: string): ExtensionContext | undefined => turnContexts.get(turnId);
  const releaseTurnContext = (turnId: string): void => {
    const ctx = turnContexts.get(turnId);
    turnContexts.delete(turnId);
    if (!ctx) return;
    const sessionId = ctx.sessionManager.getSessionId();
    if (![...turnContexts.values()].some((candidate) => candidate.sessionManager.getSessionId() === sessionId)) {
      sessionContexts.delete(sessionId);
    }
  };
  const disposeSessionContext = (ctx: ExtensionContext): void => {
    const sessionId = ctx.sessionManager.getSessionId();
    for (const [turnId, candidate] of turnContexts) {
      if (candidate.sessionManager.getSessionId() === sessionId) turnContexts.delete(turnId);
    }
    sessionContexts.delete(sessionId);
  };
  const currentContext = (ctx: ExtensionContext): boolean => Boolean(descriptor
    && descriptor.sessionId === ctx.sessionManager.getSessionId());
  const checkpointAdapter = createTurnCheckpointAdapter<workspaceGit.WorkspaceSnapshot>({
    sessionIdForTurn: (turnId) => contextForTurn(turnId)?.sessionManager.getSessionId(),
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
    acquireLease: async (turnId, signal) => {
      const ctx = contextForNewTurn(turnId);
      if (!ctx) return undefined;
      return checkpointLeaseManager.acquire(ctx.cwd, {
        sessionId: ctx.sessionManager.getSessionId(),
        turnId,
        signal,
      });
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
    discardTurnSnapshot: (turnId, phase) => {
      const ctx = contextForTurn(turnId);
      if (!ctx) return;
      const sessionId = ctx.sessionManager.getSessionId();
      return workspaceGit.deleteWorkspaceSnapshot(
        ctx.cwd,
        turnSnapshotRef(sessionId, turnId, phase),
        { sessionId, turnId, phase },
      );
    },
    appendCheckpoint: async (stored, result, capture) => {
      const sessionId = result.beforeSnapshot.sessionId;
      const ctx = sessionId ? sessionContexts.get(sessionId) : undefined;
      if (!ctx) throw new Error("Pi session is unavailable.");
      if (result.afterSnapshot.sessionId !== sessionId || result.beforeSnapshot.turnId !== capture.id
        || result.afterSnapshot.turnId !== capture.id) {
        throw new Error("Pi session snapshot ownership changed.");
      }
      if (turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), sessionId).some((entry) => entry.id === stored.id)) return;
      // The lease is held until this synchronous append succeeds. Propagating
      // a write error lets the shared lifecycle remove the provisional refs
      // instead of releasing a checkpoint that exists only in memory.
      ctx.sessionManager.appendCustomEntry(TURN_CHECKPOINT_CUSTOM_TYPE, stored);
      if (!currentContext(ctx)) return;
      try {
        broadcast({ type: "turn-checkpoint", checkpoint: cloneTurnCheckpoint(stored) }, ctx);
        // The checkpoint may anchor an otherwise empty assistant message. A
        // bounded snapshot re-announces that exact raw entry so the renderer can
        // retain the anchor instead of inventing a tail activity row.
        broadcastSnapshot(ctx);
      } catch {
        // The session entry is already durable. A transient client/encoding
        // failure must not make lifecycle cleanup delete a valid checkpoint.
      }
    },
    onError: (error, capture) => {
      const ctx = contextForTurn(capture.id);
      if (ctx && currentContext(ctx)) broadcast({ type: "turn-checkpoint-error", turnId: capture.id, message: String(error) }, ctx);
    },
    onStatus: (status, capture) => {
      const ctx = contextForTurn(capture.id);
      if (ctx && currentContext(ctx)) broadcast({ type: "turn-checkpoint-status", turnId: capture.id, status }, ctx);
    },
    onReleased: (capture) => releaseTurnContext(capture.id),
  });
  const checkpointLifecycle = new TurnCheckpointLifecycle<workspaceGit.WorkspaceSnapshot>(checkpointAdapter);

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
    if (client.socket.destroyed) return;
    try {
      client.socket.write(encodePiBridgeFrame(frame));
    } catch {
      // A malformed/oversized extension payload must not escape an event hook
      // as an unhandled exception. The client can reconnect and request a
      // bounded snapshot after this connection is dropped.
      client.socket.destroy();
      clients.delete(client);
    }
  };

  const branchMessages = (ctx: ExtensionContext): unknown[] => ctx.sessionManager.getBranch()
    .flatMap((entry) => entry.type === "message" ? [{ ...entry.message, tauEntryId: entry.id }] : []);

  const checkpointsForRawMessages = (ctx: ExtensionContext, messages: readonly unknown[]) => {
    const ids = new Set(messages.flatMap((message) => {
      if (!message || typeof message !== "object") return [];
      const id = (message as { tauEntryId?: unknown }).tauEntryId;
      return typeof id === "string" ? [id] : [];
    }));
    return turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId())
      .filter((checkpoint) => ids.has(checkpoint.anchorMessageId))
      .map(cloneTurnCheckpoint);
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
    const result: PiBridgeSnapshot = {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: file,
      cwd: ctx.cwd,
      sessionName: pi.getSessionName(),
      messages: boundedBridgeValue(visibleMessages),
      activityMessages: boundedBridgeValue(initialPage.activityMessages),
      ...(olderCursor ? { olderCursor } : {}),
      isStreaming: !ctx.isIdle(),
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name } : undefined,
      models: ctx.modelRegistry.getAvailable().slice(0, MAX_BRIDGE_CATALOG_ITEMS).map((model) => ({ provider: model.provider, id: model.id, name: boundedCatalogText(model.name) })),
      thinkingLevel: pi.getThinkingLevel(),
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      activeTools: pi.getActiveTools().slice(0, MAX_BRIDGE_CATALOG_ITEMS).map((tool) => boundedCatalogText(tool)),
      allTools: pi.getAllTools().slice(0, MAX_BRIDGE_CATALOG_ITEMS).map((tool) => ({ name: boundedCatalogText(tool.name), description: boundedCatalogText(tool.description) })),
      // A snapshot exposes only the bounded raw tail; never attach older cards
      // to this newest page. Older cards travel with their own transcript page.
      turnCheckpoints: checkpointsForRawMessages(ctx, visibleMessages),
      composerCommands: pi.getCommands()
        .filter((command) => !command.name.startsWith("tau-bridge-"))
        .slice(0, MAX_BRIDGE_CATALOG_ITEMS)
        .map((command) => ({
          name: boundedCatalogText(command.name),
          description: boundedCatalogText(command.description),
          source: command.source,
        })),
      contextUsage: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : undefined,
      taskProgress: boundedBridgeValue(taskProgressFromMessages(messages)),
      taskHistory: boundedBridgeValue(taskProgressHistoryFromMessages(messages)),
      awaitingInput,
    };
    // Bound the complete snapshot as a final guard against extension-provided
    // metadata. The transcript pager's 160-record ceiling is higher than the
    // generic array cap, so no cursor-visible records are dropped here.
    return boundedBridgePayload(result);
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
      event: boundedBridgePayload(event, PI_BRIDGE_MAX_FRAME_BYTES - 64 * 1024),
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
      ? { protocolVersion: PI_BRIDGE_PROTOCOL_VERSION, type: "response", id, epoch: descriptor.epoch, ok: true, result: boundedBridgePayload(result, PI_BRIDGE_MAX_FRAME_BYTES - 64 * 1024) }
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

  pi.on("session_start", async (event, ctx) => {
    // Settlement starts the old session's snapshot/summary writes but does not
    // hold Pi's session-switch lifecycle open. The adapter keeps the owning
    // session context, so those writes cannot drift onto the new session.
    await checkpointLifecycle.settle();
    await stop();
    let inherited = event.reason === "fork" ? previousSessionForFork : undefined;
    // A fork rebuilds the Pi extension runtime, so closure state from the
    // source extension is not guaranteed to survive the session replacement.
    // The runtime supplies the source session file precisely for this handoff;
    // reread it after the source shutdown has durably appended its final entry.
    const disposedSource = previousSessionForFork?.context;
    if (disposedSource) disposeSessionContext(disposedSource);
    if (event.reason === "fork" && event.previousSessionFile) {
      try {
        const sourceManager = SessionManager.open(event.previousSessionFile);
        inherited = {
          context: inherited?.context ?? ctx,
          sessionId: sourceManager.getSessionId(),
          cwd: sourceManager.getCwd(),
          checkpoints: turnCheckpointsFromEntries(sourceManager.getBranch(), sourceManager.getSessionId()),
        };
      } catch {
        // The in-process carrier is still useful for runtimes that expose a
        // transiently unavailable source path during fork setup.
      }
    }
    previousSessionForFork = undefined;
    if (ctx.mode !== "tui") return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    latestContext = ctx;
    sequence = 0;
    await workspaceGit.cleanupOrphanTurnCheckpointRefs(
      ctx.cwd,
      ctx.sessionManager.getSessionId(),
      turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId()),
    );
    const inheritedCheckpoints = inherited
      ? checkpointsForBranch(ctx.sessionManager.getBranch(), inherited.checkpoints)
      : [];
    if (inheritedCheckpoints.length > 0) {
      try {
        await workspaceGit.cloneTurnCheckpointRefs(
          ctx.cwd,
          inherited.sessionId,
          ctx.sessionManager.getSessionId(),
          inheritedCheckpoints,
        );
        const existing = new Set(turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId()).map((checkpoint) => checkpoint.id));
        for (const checkpoint of inheritedCheckpoints) {
          if (existing.has(checkpoint.id)) continue;
          ctx.sessionManager.appendCustomEntry(
            TURN_CHECKPOINT_CUSTOM_TYPE,
            rehomeStoredTurnCheckpoint(checkpoint, ctx.sessionManager.getSessionId()),
          );
        }
      } catch (error) {
        await workspaceGit.cleanupClonedTurnCheckpointRefs(
          ctx.cwd,
          inherited.sessionId,
          ctx.sessionManager.getSessionId(),
          inheritedCheckpoints,
        );
        ctx.ui.notify(`Turn checkpoint history could not be carried into the fork: ${String(error)}`, "error");
      }
    }
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
    bindTurnContext: (turnId, ctx) => {
      turnContexts.set(turnId, ctx);
      sessionContexts.set(ctx.sessionManager.getSessionId(), ctx);
    },
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
  pi.on("session_before_fork", (_event, ctx) => {
    // Keep a source carrier even if Pi performs the fork without emitting a
    // separate shutdown callback. The shutdown callback refreshes its entries
    // after any final checkpoint persistence has settled.
    previousSessionForFork = {
      context: ctx,
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      checkpoints: turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId()),
    };
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    await checkpointLifecycle.close();
    // Read the branch after the awaited settle: a checkpoint that was in the
    // final persistence phase must be part of a subsequent fork as well.
    previousSessionForFork = {
      context: ctx,
      sessionId,
      cwd: ctx.cwd,
      checkpoints: turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), sessionId),
    };
    disposeSessionContext(ctx);
    await stop();
  });
}
