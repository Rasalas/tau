import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatChatTranscript } from "../../src/shared/chat-transcript.js";
import { taskProgressFromMessages, taskProgressHistoryFromMessages } from "../../src/shared/task-progress.js";
import type { DiffLoadOptions, UiFileDiff, UiWorkspaceChanges } from "../../src/shared/contracts.js";
import * as workspaceGit from "../../src/main/workspace-git.js";
import {
  changesSinceTurn,
  summariesFromStoredTurnCheckpoints,
  TURN_CHECKPOINT_CUSTOM_TYPE,
  turnCheckpointsFromEntries,
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
} from "../../src/shared/pi-bridge-protocol.js";

interface ClientState { socket: Socket; authenticated: boolean; buffer: string }

interface LiveTurnCheckpointState {
  id: string;
  startedAt: number;
  baseline: Promise<UiWorkspaceChanges | undefined>;
  outcome?: "completed" | "aborted" | "error";
  lastAssistant?: { stopReason?: string; timestamp?: number };
}

const MAX_CHECKPOINT_DIFF_FILES = 256;

function boundedBridgeValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "string") return item;
    const bytes = Buffer.from(item, "utf8");
    if (bytes.length <= 32 * 1024) return item;
    return `${bytes.subarray(0, 32 * 1024).toString("utf8")}\n[Bridge value truncated from ${bytes.length} bytes]`;
  })) as T;
}

function copyDiff(diff: UiFileDiff): UiFileDiff {
  return {
    ...diff,
    hunks: diff.hunks.map((hunk) => ({
      ...hunk,
      lines: hunk.lines.map((line) => ({ ...line })),
    })),
  };
}

function pageHistoricalDiff(diff: UiFileDiff, options?: DiffLoadOptions): UiFileDiff {
  if (!options || (options.hunkOffset === undefined && options.hunkLimit === undefined)) return copyDiff(diff);
  const offset = Math.max(0, options.hunkOffset ?? 0);
  const limit = Math.min(
    workspaceGit.MAX_DIFF_HUNKS,
    Math.max(1, options.hunkLimit ?? workspaceGit.MAX_DIFF_HUNKS),
  );
  const result = copyDiff(diff);
  result.hunks = result.hunks.slice(offset, offset + limit);
  const hasMore = offset + result.hunks.length < diff.hunks.length;
  result.truncated = Boolean(diff.truncated || hasMore);
  result.nextHunkOffset = hasMore ? offset + result.hunks.length : undefined;
  if (hasMore) result.note = `Showing ${result.hunks.length} captured hunks. Load more to continue.`;
  return result;
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
        ...(initialPrompt ? { withSession: async (fresh) => { await fresh.sendUserMessage(initialPrompt); } } : {}),
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
  /**
   * Pi owns its own UI context while it owns the runtime, so an extension cannot
   * intercept another extension's question — it is answered in Pi's terminal.
   * What Tau can be told is that the thread is stalled on one.
   */
  let awaitingInput: PiBridgeAwaitingInput | undefined;
  let sequence = 0;
  const clients = new Set<ClientState>();
  let currentTurn: LiveTurnCheckpointState | undefined;
  let checkpointWrite: Promise<void> = Promise.resolve();

  const beginTurnCheckpoint = (ctx: ExtensionContext): void => {
    if (currentTurn) return;
    const baseline = workspaceGit.readProjectGitState(ctx.cwd, { throwOnError: true })
      .then((state) => state.changes)
      .catch(() => undefined);
    currentTurn = { id: randomUUID(), startedAt: Date.now(), baseline };
  };

  const updateTurnCheckpointOutcome = (event: Record<string, unknown>): void => {
    if (!currentTurn) return;
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const assistant = [...messages].reverse().find((message) =>
      message && typeof message === "object" && (message as { role?: string }).role === "assistant",
    ) as { stopReason?: string; timestamp?: number } | undefined;
    if (!assistant) return;
    currentTurn.lastAssistant = assistant;
    if (event.willRetry) {
      // Keep one checkpoint identity across a provider retry. The first
      // low-level response is not the settled turn's outcome.
      currentTurn.outcome = undefined;
    } else if (assistant.stopReason === "aborted") currentTurn.outcome = "aborted";
    else if (assistant.stopReason === "error") currentTurn.outcome = "error";
    else currentTurn.outcome = "completed";
  };

  const updateTurnCheckpointAssistant = (event: Record<string, unknown>): void => {
    if (!currentTurn) return;
    const message = event.message;
    if (!message || typeof message !== "object" || (message as { role?: string }).role !== "assistant") return;
    const assistant = message as { stopReason?: string; timestamp?: number };
    currentTurn.lastAssistant = assistant;
  };

  const settleTurnCheckpoint = async (ctx: ExtensionContext): Promise<void> => {
    const turn = currentTurn;
    currentTurn = undefined;
    if (!turn || turn.outcome !== "completed") return;
    const baseline = await turn.baseline;
    if (!baseline) return;
    let current: UiWorkspaceChanges;
    try {
      current = (await workspaceGit.readProjectGitState(ctx.cwd, { throwOnError: true })).changes;
    } catch {
      return;
    }
    const changes = changesSinceTurn(baseline, current);
    const branch = ctx.sessionManager.getBranch();
    const anchorMessageId = [...branch].reverse().find((entry) =>
      entry.type === "message" && entry.message.role === "assistant",
    )?.id ?? `assistant-live-${turn.lastAssistant?.timestamp ?? turn.id}`;
    const stored: StoredTurnCheckpoint = {
      id: turn.id,
      turnId: turn.id,
      sessionId: ctx.sessionManager.getSessionId(),
      anchorMessageId,
      startedAt: turn.startedAt,
      endedAt: Date.now(),
      branch: changes.branch,
      files: changes.files.map((file) => ({ ...file })),
      added: changes.added,
      removed: changes.removed,
      diffs: {},
    };
    const files = current.files.filter((file) => changes.files.some((item) => item.path === file.path));
    for (let index = 0; index < files.length && index < MAX_CHECKPOINT_DIFF_FILES; index += 4) {
      const captured = await Promise.all(files.slice(index, index + 4).map(async (file) => [
        file.path,
        await workspaceGit.getFileDiff(ctx.cwd, file.path, { hunkLimit: workspaceGit.MAX_DIFF_HUNKS }),
      ] as const));
      for (const [path, diff] of captured) stored.diffs[path] = diff;
    }
    if (turnCheckpointsFromEntries(branch, stored.sessionId).some((entry) => entry.id === stored.id)) return;
    ctx.sessionManager.appendCustomEntry(TURN_CHECKPOINT_CUSTOM_TYPE, stored);
  };

  const historicalDiff = (ctx: ExtensionContext, checkpointId: string, path: string, options?: DiffLoadOptions): UiFileDiff => {
    const checkpoint = turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId())
      .find((entry) => entry.id === checkpointId);
    const summary = checkpoint?.files.find((file) => file.path === path);
    if (!checkpoint || !summary) return { path, added: 0, removed: 0, hunks: [], note: "This turn checkpoint is no longer available." };
    const diff = checkpoint.diffs[path];
    return diff
      ? pageHistoricalDiff(diff, options)
      : { path, added: summary.added, removed: summary.removed, hunks: [], note: "No historical textual diff was captured for this file." };
  };

  const send = (client: ClientState, frame: PiBridgeServerFrame) => {
    if (!client.socket.destroyed) client.socket.write(encodePiBridgeFrame(frame));
  };

  const snapshot = (ctx: ExtensionContext): PiBridgeSnapshot => {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) throw new Error("Tau bridge requires a persisted Pi session.");
    const usage = ctx.getContextUsage();
    const branchMessages = ctx.sessionManager.getBranch()
      .flatMap((entry) => entry.type === "message" ? [{ ...entry.message, tauEntryId: entry.id }] : []);
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: file,
      cwd: ctx.cwd,
      sessionName: pi.getSessionName(),
      messages: boundedBridgeValue(branchMessages.slice(-160)),
      isStreaming: !ctx.isIdle(),
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name } : undefined,
      models: ctx.modelRegistry.getAvailable().map((model) => ({ provider: model.provider, id: model.id, name: model.name })),
      thinkingLevel: pi.getThinkingLevel(),
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      activeTools: pi.getActiveTools(),
      allTools: pi.getAllTools().map((tool) => ({ name: tool.name, description: tool.description })),
      turnCheckpoints: summariesFromStoredTurnCheckpoints(
        turnCheckpointsFromEntries(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId()),
      ),
      composerCommands: pi.getCommands()
        .filter((command) => !command.name.startsWith("tau-bridge-"))
        .map((command) => ({
          name: command.name,
          description: command.description,
          source: command.source,
        })),
      contextUsage: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : undefined,
      taskProgress: taskProgressFromMessages(branchMessages),
      taskHistory: taskProgressHistoryFromMessages(branchMessages),
      awaitingInput,
    };
  };

  const broadcast = (event: unknown, ctx: ExtensionContext) => {
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
    if (!descriptor) return;
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
          pi.sendUserMessage(frame.text, {
            ...(ctx.isIdle() ? {} : { deliverAs: frame.deliverAs ?? "followUp" }),
            expandPromptTemplates: true,
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
          respond(client, frame.id, true, historicalDiff(ctx, frame.checkpointId, frame.path, frame));
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
    await stop();
    currentTurn = undefined;
    checkpointWrite = Promise.resolve();
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
  for (const eventName of [
    "agent_start", "agent_end", "agent_settled", "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end", "queue_update", "model_select",
    "thinking_level_select", "ui_prompt_start", "ui_prompt_end",
  ] as const) onAny(eventName, async (event, ctx) => {
    if (eventName === "agent_start") beginTurnCheckpoint(ctx);
    if (eventName === "agent_end") updateTurnCheckpointOutcome(event);
    if (eventName === "message_end") updateTurnCheckpointAssistant(event);
    if (eventName === "agent_settled") {
      const previous = checkpointWrite;
      checkpointWrite = previous.catch(() => undefined).then(() => settleTurnCheckpoint(ctx));
      await checkpointWrite.catch(() => undefined);
    }
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
  pi.on("session_shutdown", async () => { await stop(); });
}
