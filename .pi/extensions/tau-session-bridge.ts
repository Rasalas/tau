import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  branchMessagesWithClientMessageIds,
  clientMessageIdForMessage,
  CLIENT_MESSAGE_MARKER,
  CLIENT_MESSAGE_CANCEL_MARKER,
  unclaimedClientMessageIds,
} from "../../src/main/client-message-correlation.js";
import { normalizePiBridgePrompt, PI_RUNTIME_ADAPTER, skillMessagePresentation } from "../../src/main/skill-invocation.js";
import { taskProgressFromMessages, taskProgressHistoryFromMessages } from "../../src/shared/task-progress.js";
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

function boundedBridgeValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "string") return item;
    const bytes = Buffer.from(item, "utf8");
    if (bytes.length <= 32 * 1024) return item;
    return `${bytes.subarray(0, 32 * 1024).toString("utf8")}\n[Bridge value truncated from ${bytes.length} bytes]`;
  })) as T;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
}

export default function tauSessionBridge(pi: ExtensionAPI) {
  const normalizePrompt = (text: string): string => normalizePiBridgePrompt(text, pi.getCommands());
  const pendingClientMessageIds: string[] = [];
  /** Markers already assigned to a message_start but not finalized at message_end. */
  const inFlightClientMessageIds = new Set<string>();
  /** One-shot restart failures for a host that reconnects after an orphaned request. */
  const failedClientMessageIds = new Set<string>();

  const appendClientMessageMarker = (ctx: ExtensionContext, clientMessageId: string | undefined): boolean => {
    if (!clientMessageId) return false;
    pendingClientMessageIds.push(clientMessageId);
    ctx.sessionManager.appendCustomEntry(CLIENT_MESSAGE_MARKER, { clientMessageId });
    return true;
  };

  const cancelClientMessageMarker = (ctx: ExtensionContext, clientMessageId: string | undefined): boolean => {
    if (!clientMessageId) return false;
    const wasPending = pendingClientMessageIds.includes(clientMessageId);
    const wasInFlight = inFlightClientMessageIds.delete(clientMessageId);
    if (!wasPending && !wasInFlight) return false;
    forgetClientMessageId(clientMessageId);
    ctx.sessionManager.appendCustomEntry(CLIENT_MESSAGE_CANCEL_MARKER, { clientMessageId });
    return true;
  };

  const forgetClientMessageId = (clientMessageId: string): void => {
    for (;;) {
      const pending = pendingClientMessageIds.indexOf(clientMessageId);
      if (pending < 0) break;
      pendingClientMessageIds.splice(pending, 1);
    }
    inFlightClientMessageIds.delete(clientMessageId);
  };

  const trackedClientMessageIds = (): string[] => [...new Set([
    ...pendingClientMessageIds,
    ...inFlightClientMessageIds,
  ])];

  /** Only an id on a persisted user entry proves that the request was recorded. */
  const persistedClientMessageIds = (ctx: ExtensionContext): Set<string> => new Set(
    ctx.sessionManager.getBranch().flatMap((entry) => {
      if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") return [];
      const message = (entry as { message?: unknown }).message;
      if (!message || typeof message !== "object") return [];
      const value = message as { role?: unknown; clientMessageId?: unknown };
      return value.role === "user" && typeof value.clientMessageId === "string" && value.clientMessageId.length > 0
        ? [value.clientMessageId]
        : [];
    }),
  );

  const failClientMessageIfUnpersisted = (ctx: ExtensionContext, clientMessageId: string | undefined): boolean => {
    if (!clientMessageId) return false;
    if (persistedClientMessageIds(ctx).has(clientMessageId)) {
      forgetClientMessageId(clientMessageId);
      return false;
    }
    const cancelled = cancelClientMessageMarker(ctx, clientMessageId);
    if (cancelled) broadcastUserMessageFailure(ctx, clientMessageId);
    return cancelled;
  };

  const settlePendingClientMessageIds = (ctx: ExtensionContext): void => {
    if (pendingClientMessageIds.length === 0 && inFlightClientMessageIds.size === 0) return;
    const persistedIds = persistedClientMessageIds(ctx);
    for (const clientMessageId of trackedClientMessageIds()) {
      if (persistedIds.has(clientMessageId)) {
        forgetClientMessageId(clientMessageId);
      } else {
        failClientMessageIfUnpersisted(ctx, clientMessageId);
      }
    }
    pendingClientMessageIds.length = 0;
    inFlightClientMessageIds.clear();
  };

  const correlateUserMessageStart = (message: unknown): void => {
    if (!message || typeof message !== "object") return;
    const value = message as { role?: string; clientMessageId?: unknown };
    if (value.role !== "user") return;
    if (typeof value.clientMessageId === "string") {
      const pending = pendingClientMessageIds.indexOf(value.clientMessageId);
      if (pending >= 0) {
        pendingClientMessageIds.splice(pending, 1);
        inFlightClientMessageIds.add(value.clientMessageId);
      }
      return;
    }
    const clientMessageId = pendingClientMessageIds.shift();
    if (clientMessageId) {
      inFlightClientMessageIds.add(clientMessageId);
      (message as Record<string, unknown>).clientMessageId = clientMessageId;
    }
  };

  const branchMessagesWithEntryIds = (ctx: ExtensionContext): unknown[] => {
    const entries = ctx.sessionManager.getBranch();
    const messages = branchMessagesWithClientMessageIds(entries);
    let messageIndex = 0;
    return entries.flatMap((entry) => entry.type === "message"
      ? [{ ...(messages[messageIndex++] as Record<string, unknown>), tauEntryId: entry.id }]
      : []);
  };

  const normalizedTranscriptMessage = (message: unknown): { role: "user" | "assistant"; content: unknown } | undefined => {
    if (!message || typeof message !== "object") return undefined;
    const value = message as { role?: string; content?: unknown };
    if (value.role !== "user" && value.role !== "assistant") return undefined;
    if (value.role === "assistant") return { role: "assistant", content: value.content };
    const text = textFromContent(value.content);
    const presentation = skillMessagePresentation(text, PI_RUNTIME_ADAPTER, pi.getCommands());
    if (!presentation) return { role: "user", content: value.content };
    const images = Array.isArray(value.content)
      ? value.content.filter((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "image")
      : [];
    return {
      role: "user",
      content: [
        ...(presentation.text ? [{ type: "text", text: presentation.text }] : []),
        ...images,
      ],
    };
  };

  pi.registerCommand("tau-bridge-reload", {
    description: "Reload Pi resources for an attached Tau client",
    handler: async (_args, ctx) => ctx.reload(),
  });
  pi.registerCommand("tau-bridge-new", {
    description: "Create a new Pi session for an attached Tau client",
    handler: async (args, ctx) => {
      const decoded = args ? JSON.parse(Buffer.from(args, "base64url").toString("utf8")) as unknown : undefined;
      const payload = typeof decoded === "string" ? { initialPrompt: decoded } : decoded && typeof decoded === "object" ? decoded as { initialPrompt?: unknown; clientMessageId?: unknown } : {};
      const initialPrompt = typeof payload.initialPrompt === "string" ? payload.initialPrompt : undefined;
      const clientMessageId = typeof payload.clientMessageId === "string" ? payload.clientMessageId : undefined;
      await ctx.newSession({
        ...(initialPrompt ? { withSession: async (fresh) => {
          const marker = appendClientMessageMarker(fresh, clientMessageId);
          try {
            await fresh.sendUserMessage(normalizePrompt(initialPrompt), { expandPromptTemplates: true });
            if (marker) failClientMessageIfUnpersisted(fresh, clientMessageId);
          } catch (error) {
            if (marker) failClientMessageIfUnpersisted(fresh, clientMessageId);
            throw error;
          }
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
    const branchMessages = ctx.sessionManager.getBranch()
      .flatMap((entry) => entry.type === "message" ? [{ ...entry.message, tauEntryId: entry.id }] : []);
    return {
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: file,
      cwd: ctx.cwd,
      sessionName: pi.getSessionName(),
      messages: boundedBridgeValue(branchMessagesWithEntryIds(ctx).slice(-160)),
      isStreaming: !ctx.isIdle(),
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name } : undefined,
      runtimeCapabilities: PI_RUNTIME_ADAPTER.capabilities,
      failedClientMessageIds: failedClientMessageIds.size > 0 ? [...failedClientMessageIds] : undefined,
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

  const decorateEvent = (event: unknown, ctx: ExtensionContext): unknown => {
    if (!event || typeof event !== "object") return event;
    const value = event as { message?: unknown };
    if (!value.message || typeof value.message !== "object" || (value.message as { role?: unknown }).role !== "user") return event;
    const existing = value.message as { clientMessageId?: unknown };
    if (typeof existing.clientMessageId === "string") return event;
    const clientMessageId = clientMessageIdForMessage(ctx.sessionManager.getBranch(), value.message);
    return clientMessageId ? { ...value, message: { ...existing, clientMessageId } } : event;
  };

  const finalizeUserMessage = (ctx: ExtensionContext, message: unknown): void => {
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "user") return;
    const value = message as { clientMessageId?: unknown };
    const clientMessageId = typeof value.clientMessageId === "string"
      ? value.clientMessageId
      : clientMessageIdForMessage(ctx.sessionManager.getBranch(), message);
    if (clientMessageId) forgetClientMessageId(clientMessageId);
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
      event: boundedBridgeValue(decorateEvent(event, ctx)),
    };
    for (const client of clients) if (client.authenticated) send(client, frame);
  };

  const broadcastUserMessageFailure = (ctx: ExtensionContext, clientMessageId: string | undefined): void => {
    if (!clientMessageId) return;
    broadcast({
      type: "user_message_failed",
      clientMessageId,
      message: "Pi did not add the prompt to the transcript.",
    }, ctx);
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
      const readySnapshot = snapshot(ctx);
      send(client, {
        protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
        type: "ready",
        id: frame.id,
        epoch: descriptor.epoch,
        snapshot: readySnapshot,
      });
      // The ready snapshot is the host's only chance to observe failures that
      // happened before it reconnected; do not repeat them in later snapshots.
      failedClientMessageIds.clear();
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
          const marker = appendClientMessageMarker(ctx, frame.clientMessageId);
          try {
            const wasIdle = ctx.isIdle();
            const normalizedText = normalizePrompt(frame.text);
            const commandName = normalizedText.startsWith("/")
              ? normalizedText.slice(1).split(/[ \t\r\n]/u, 1)[0]
              : "";
            const isExtensionCommand = pi.getCommands().some((command) => command.source === "extension" && command.name === commandName);
            const send = pi.sendUserMessage(normalizedText, {
              ...(wasIdle ? {} : { deliverAs: frame.deliverAs ?? "followUp" }),
              expandPromptTemplates: true,
            });
            void send.then(() => {
              // Extension commands can complete without creating a user
              // message, whether or not another run is active. Remove their
              // marker so it cannot label the next turn.
              if (marker && (wasIdle || isExtensionCommand)) failClientMessageIfUnpersisted(ctx, frame.clientMessageId);
            }).catch(() => {
              if (marker) failClientMessageIfUnpersisted(ctx, frame.clientMessageId);
            });
          } catch (error) {
            if (marker) failClientMessageIfUnpersisted(ctx, frame.clientMessageId);
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
            .flatMap((entry) => entry.type === "message" ? [normalizedTranscriptMessage(entry.message)] : []);
          if (Buffer.byteLength(JSON.stringify(messages), "utf8") > PI_BRIDGE_MAX_FRAME_BYTES - 1024) {
            throw new Error("This thread is too large to copy through the Tau bridge.");
          }
          respond(client, frame.id, true, {
            title: pi.getSessionName(),
            cwd: ctx.cwd,
            sessionId: ctx.sessionManager.getSessionId(),
            messages: messages.flatMap((message) => message ? [message] : []),
          });
          break;
        }
        case "new_session": {
          if (!ctx.isIdle()) throw new Error("Wait for the active run before creating a new thread.");
          respond(client, frame.id, true, { accepted: true });
          setTimeout(() => {
            const encodedPrompt = frame.initialPrompt
              ? ` ${Buffer.from(JSON.stringify({ initialPrompt: frame.initialPrompt, clientMessageId: frame.clientMessageId }), "utf8").toString("base64url")}`
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
    for (const clientMessageId of unclaimedClientMessageIds(ctx.sessionManager.getBranch())) {
      ctx.sessionManager.appendCustomEntry(CLIENT_MESSAGE_CANCEL_MARKER, { clientMessageId });
      failedClientMessageIds.add(clientMessageId);
    }
    pendingClientMessageIds.length = 0;
    inFlightClientMessageIds.clear();
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
    if (eventName === "message_start" && event.message && (event.message as { role?: unknown }).role === "user") {
      correlateUserMessageStart(event.message);
    }
    if (eventName === "message_end" && event.message && (event.message as { role?: unknown }).role === "user") {
      finalizeUserMessage(ctx, event.message);
    }
    // A queued follow-up can make an inner agent turn settle while Pi is still
    // running. Do not cancel its marker until the runtime is genuinely idle.
    if (eventName === "agent_settled" && ctx.isIdle()) settlePendingClientMessageIds(ctx);
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
    pendingClientMessageIds.length = 0;
    inFlightClientMessageIds.clear();
    await stop();
  });
}
