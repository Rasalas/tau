import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatChatTranscript } from "../../src/shared/chat-transcript.js";
import { taskProgressFromMessages, taskProgressHistoryFromMessages } from "../../src/shared/task-progress.js";
import type { ClientTurnIdentity } from "../../src/shared/contracts.js";
import { ClientTurnLedgerStore, type ClientTurnLedgerObservation } from "../../src/shared/client-turn-ledger.js";
import { clientIdentityMatches, resolveClientTurnIdentity, hasExplicitClientIdentity } from "../../src/shared/transcript-turn.js";
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

export interface BridgeMessageObservation {
  role?: string;
  content?: unknown;
  timestamp?: number;
  clientTurnId?: string;
  clientMessageId?: string;
  tauClientTurnId?: string;
  tauClientMessageId?: string;
}

export const BRIDGE_TURN_PENDING_LIMIT = 64;
export const BRIDGE_TURN_TOTAL_PENDING_LIMIT = 1_024;
export const BRIDGE_TURN_REMEMBERED_LIMIT = 256;
export const BRIDGE_TURN_TOTAL_REMEMBERED_LIMIT = 1_024;

export function bridgeVisibleText(message: BridgeMessageObservation): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const value = part as { type?: string; text?: string };
    return value.type === "text" ? value.text ?? "" : "";
  }).join("");
}

export function normalizeBridgeFingerprint(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

function bridgeIdentity(message: BridgeMessageObservation): ClientTurnIdentity | undefined {
  const clientTurnId = message.clientTurnId ?? message.tauClientTurnId;
  const clientMessageId = message.clientMessageId ?? message.tauClientMessageId;
  return resolveClientTurnIdentity({ clientTurnId, clientMessageId });
}

function hasExplicitBridgeIdentity(message: BridgeMessageObservation): boolean {
  return hasExplicitClientIdentity({
    clientTurnId: message.clientTurnId ?? message.tauClientTurnId,
    clientMessageId: message.clientMessageId ?? message.tauClientMessageId,
  });
}

/**
 * Pi 0.84 does not expose metadata on sendUserMessage. This bounded ledger
 * carries the renderer identity across command dispatch, expansion, session
 * creation, and the later persisted branch entry. Explicit IDs always win;
 * fingerprint and command order are compatibility fallbacks only.
 */
export class BridgeClientTurnLedger {
  private readonly store = new ClientTurnLedgerStore({
    pendingPerScope: BRIDGE_TURN_PENDING_LIMIT,
    pendingTotal: BRIDGE_TURN_TOTAL_PENDING_LIMIT,
    rememberedPerScope: BRIDGE_TURN_REMEMBERED_LIMIT,
    rememberedTotal: BRIDGE_TURN_TOTAL_REMEMBERED_LIMIT,
  });

  enqueue(sessionId: string | undefined, identity: ClientTurnIdentity, submittedText: string): number {
    const metadata = { fingerprint: normalizeBridgeFingerprint(submittedText) };
    return (sessionId
      ? this.store.enqueue(sessionId, identity, metadata)
      : this.store.enqueueAny(identity, metadata)).sequence;
  }

  enqueueAny(identity: ClientTurnIdentity, submittedText: string): number {
    return this.store.enqueueAny(identity, { fingerprint: normalizeBridgeFingerprint(submittedText) }).sequence;
  }

  cancel(sessionId: string | undefined, identity: ClientTurnIdentity): void {
    this.store.cancel(sessionId, identity);
  }

  cancelAny(identity: ClientTurnIdentity): void {
    this.store.cancel(undefined, identity);
  }

  claim(
    sessionId: string,
    message: BridgeMessageObservation,
    rawMessage?: object,
    allowCommandOrderFallback = true,
  ): ClientTurnIdentity | undefined {
    if (message.role !== undefined && message.role !== "user") return undefined;
    const explicit = bridgeIdentity(message);
    if (hasExplicitBridgeIdentity(message)) {
      if (!explicit) return undefined;
      const selected = this.store.findPending(sessionId, (entry) => clientIdentityMatches(explicit, entry.identity), { bySequence: true });
      if (selected) this.store.removePending(selected);
      this.remember(sessionId, message, explicit, rawMessage);
      return explicit;
    }
    const remembered = rawMessage ? this.store.identityForRaw(rawMessage) : undefined;
    if (remembered) return remembered;

    const fingerprint = normalizeBridgeFingerprint(bridgeVisibleText(message));
    const selected = this.store.findPending(sessionId, (entry) => entry.fingerprint === fingerprint, { bySequence: true })
      ?? (allowCommandOrderFallback ? this.store.findPending(sessionId, () => true, { bySequence: true }) : undefined);
    if (!selected) {
      // Pi may hand message_start and message_end different object instances.
      // Recover the already observed identity by the bounded legacy key before
      // giving up; a later explicit identity still remains authoritative.
      const observed = this.identityForMessage(sessionId, message);
      if (observed) {
        this.remember(sessionId, message, observed, rawMessage);
        return observed;
      }
      return undefined;
    }
    this.store.removePending(selected);
    this.remember(sessionId, message, selected.entry.identity, rawMessage);
    return selected.entry.identity;
  }

  remember(
    sessionId: string,
    message: BridgeMessageObservation,
    identity: ClientTurnIdentity,
    rawMessage?: object,
    sourceEntryId?: string,
  ): void {
    const observation: ClientTurnLedgerObservation = {
      sourceEntryId,
      fingerprint: normalizeBridgeFingerprint(bridgeVisibleText(message)),
      timestamp: message.timestamp,
    };
    this.store.remember(sessionId, observation, identity, rawMessage);
  }

  rememberEntry(sessionId: string, sourceEntryId: string, message: BridgeMessageObservation): void {
    if (message.role !== undefined && message.role !== "user") return;
    const withEntryId = { ...message, tauEntryId: sourceEntryId };
    const identity = bridgeIdentity(message) ?? (message && typeof message === "object" ? this.store.identityForRaw(message) : undefined)
      ?? this.identityForMessage(sessionId, withEntryId)
      // A snapshot can contain old branch entries while a newer command is
      // still pending. Only an exact visible fingerprint may claim here; the
      // event path retains command-order fallback for expanded prompts.
      ?? this.claim(sessionId, withEntryId, undefined, false);
    if (identity) this.remember(sessionId, message, identity, message as object, sourceEntryId);
  }

  identityForMessage(sessionId: string, message: BridgeMessageObservation): ClientTurnIdentity | undefined {
    if (message.role !== undefined && message.role !== "user") return undefined;
    if (hasExplicitBridgeIdentity(message)) return bridgeIdentity(message);
    const entries = this.store.rememberedEntries(sessionId);
    const sourceEntryId = (message as { tauEntryId?: string }).tauEntryId;
    const source = sourceEntryId ? entries.find((entry) => entry.sourceEntryId === sourceEntryId) : undefined;
    if (source) return source.identity;
    const fingerprint = normalizeBridgeFingerprint(bridgeVisibleText(message));
    const fingerprintMatches = entries.filter((entry) => entry.fingerprint === fingerprint);
    if (message.timestamp !== undefined) {
      const exactTimestamp = fingerprintMatches.find((entry) => entry.timestamp === message.timestamp);
      if (exactTimestamp) return exactTimestamp.identity;
    }
    // A persisted branch may assign a fresh timestamp while retaining the
    // visible prompt. Recover a unique expanded command without allowing an
    // ambiguous duplicate prompt to steal another turn.
    return fingerprintMatches.length === 1 ? fingerprintMatches[0].identity : undefined;
  }

  clearSession(sessionId: string): void { this.store.clear(sessionId); }

  settle(sessionId: string): void { this.clearSession(sessionId); }

  clear(preserveAny = false): void {
    this.store.clear(undefined, { preserveAny });
  }

  get size(): number { return this.store.size; }
}

export function decorateBridgeUserMessage(
  ledger: BridgeClientTurnLedger,
  message: BridgeMessageObservation,
  sessionId: string,
): void {
  if (message.role !== "user") return;
  const text = bridgeVisibleText(message).trim();
  if (text.startsWith("/tau-bridge-new")
    || text.startsWith("/tau-bridge-reload")
    || text.startsWith("/tau-bridge-fork")) return;
  // Assistant lifecycle events can expose an empty placeholder object. It is
  // never a submitted prompt, so it must not consume the next ledger entry.
  if (!text && !hasExplicitBridgeIdentity(message)) return;
  const identity = ledger.claim(sessionId, message, message as object);
  if (!identity) return;
  const raw = message as Record<string, unknown>;
  // Namespaced fields avoid colliding with provider message schemas while
  // remaining in Pi's persisted JSON and bridge snapshots.
  raw.tauClientTurnId = identity.clientTurnId;
  raw.tauClientMessageId = identity.clientMessageId;
}

export function bridgeSnapshotMessages(
  ledger: BridgeClientTurnLedger,
  sessionId: string,
  entries: readonly { type: string; id: string; message?: unknown }[],
): unknown[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return [];
    const message = entry.message as BridgeMessageObservation & Record<string, unknown>;
    ledger.rememberEntry(sessionId, entry.id, message);
    const identity = ledger.identityForMessage(sessionId, message);
    return [{ ...message, tauEntryId: entry.id, ...(identity ? {
      tauClientTurnId: identity.clientTurnId,
      tauClientMessageId: identity.clientMessageId,
    } : {}) }];
  });
}

function boundedBridgeValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "string") return item;
    const bytes = Buffer.from(item, "utf8");
    if (bytes.length <= 32 * 1024) return item;
    return `${bytes.subarray(0, 32 * 1024).toString("utf8")}\n[Bridge value truncated from ${bytes.length} bytes]`;
  })) as T;
}

export default function tauSessionBridge(pi: ExtensionAPI) {
  const bridgeTurns = new BridgeClientTurnLedger();

  const frameIdentity = (frame: { clientTurnId?: string; clientMessageId?: string }): ClientTurnIdentity | undefined => (
    resolveClientTurnIdentity(frame)
  );

  const decorateUserMessage = (message: BridgeMessageObservation, sessionId: string): void => {
    decorateBridgeUserMessage(bridgeTurns, message, sessionId);
  };

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

  const send = (client: ClientState, frame: PiBridgeServerFrame) => {
    if (!client.socket.destroyed) client.socket.write(encodePiBridgeFrame(frame));
  };

  const snapshot = (ctx: ExtensionContext): PiBridgeSnapshot => {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) throw new Error("Tau bridge requires a persisted Pi session.");
    const usage = ctx.getContextUsage();
    const branchMessages = bridgeSnapshotMessages(
      bridgeTurns,
      ctx.sessionManager.getSessionId(),
      ctx.sessionManager.getBranch() as readonly { type: string; id: string; message?: unknown }[],
    );
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
        case "prompt": {
          const identity = frameIdentity(frame);
          if (identity) bridgeTurns.enqueue(ctx.sessionManager.getSessionId(), identity, frame.text);
          try {
            pi.sendUserMessage(frame.text, {
              ...(ctx.isIdle() ? {} : { deliverAs: frame.deliverAs ?? "followUp" }),
              expandPromptTemplates: true,
            });
          } catch (error) {
            if (identity) bridgeTurns.cancel(ctx.sessionManager.getSessionId(), identity);
            throw error;
          }
          respond(client, frame.id, true, { accepted: true });
          break;
        }
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
        case "new_session": {
          if (!ctx.isIdle()) throw new Error("Wait for the active run before creating a new thread.");
          const identity = frameIdentity(frame);
          if (identity) bridgeTurns.enqueueAny(identity, frame.initialPrompt ?? "");
          respond(client, frame.id, true, { accepted: true });
          setTimeout(() => {
            const encodedPrompt = frame.initialPrompt
              ? ` ${Buffer.from(JSON.stringify(frame.initialPrompt), "utf8").toString("base64url")}`
              : "";
            try {
              pi.sendUserMessage(`/tau-bridge-new${encodedPrompt}`, { expandPromptTemplates: true });
            } catch (error) {
              if (identity) bridgeTurns.cancelAny(identity);
              void error;
            }
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

  const stop = async (preservePendingAny = true) => {
    const closing = descriptor;
    descriptor = undefined;
    latestContext = undefined;
    if (closing) bridgeTurns.clearSession(closing.sessionId);
    if (!preservePendingAny) bridgeTurns.clear();
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
    await stop(true);
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
    handler: (event: Record<string, unknown>, ctx: ExtensionContext) => void,
  ) => void;
  for (const eventName of [
    "agent_start", "agent_end", "agent_settled", "message_start", "message_update", "message_end",
    "tool_execution_start", "tool_execution_update", "tool_execution_end", "queue_update", "model_select",
    "thinking_level_select", "ui_prompt_start", "ui_prompt_end",
  ] as const) onAny(eventName, (event, ctx) => {
    if ((eventName === "message_start" || eventName === "message_end")
      && event.message && typeof event.message === "object") {
      decorateUserMessage(event.message as BridgeMessageObservation, ctx.sessionManager.getSessionId());
    }
    broadcast({ ...event, type: eventName }, ctx);
    if (eventName === "message_end" || eventName === "agent_settled" || eventName === "model_select" || eventName === "thinking_level_select") {
      broadcastSnapshot(ctx);
    }
    // Send the final snapshot while the bounded remembered correlation is still
    // available. Pi normally persists the namespaced fields on the same object,
    // but this ordering also covers runtimes that clone entries before writing.
    if (eventName === "agent_settled") bridgeTurns.settle(ctx.sessionManager.getSessionId());
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
  pi.on("session_shutdown", async () => { await stop(false); bridgeTurns.clear(); });
}
