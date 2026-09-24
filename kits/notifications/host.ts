import { HostCommandError, type HostExtension } from "tau/host-extension";
import { AttentionBook, type AttentionChange } from "./attention.js";
import {
  ATTENDED_COMMAND,
  ATTENTION_EVENT,
  NOTIFICATIONS_EXTENSION_ID,
  NOTIFY_EVENT,
  PRESENCE_REQUEST_EVENT,
  promptReason,
  type AttentionReason,
  type PresenceInput,
  type PresenceReply,
} from "./protocol.js";

const DEFAULT_DEBOUNCE_MS = 5_000;

export interface NotificationsHostOptions {
  now?: () => number;
  debounceMs?: number;
}

function decodePresence(input: unknown): PresenceInput {
  const value = input as Partial<PresenceInput> | null;
  if (!value || typeof value.clientKey !== "string" || !value.clientKey || typeof value.focused !== "boolean") {
    throw new HostCommandError("presence takes { clientKey, focused, threadId? }.");
  }
  return {
    clientKey: value.clientKey,
    focused: value.focused,
    ...(typeof value.threadId === "string" && value.threadId ? { threadId: value.threadId } : {}),
    ...(value.idle === true ? { idle: true } : {}),
  };
}

/**
 * Decides what happened and who should hear of it: a turn that ended or
 * failed, a question a thread asks. Showing it is each client's own job; this
 * half only follows which clients look at which thread, so one notification
 * reaches one client and a thread on screen notifies nobody.
 */
export function createNotificationsHostExtension(options: NotificationsHostOptions = {}): HostExtension {
  return {
    id: NOTIFICATIONS_EXTENSION_ID,
    name: "Notifications",
    permissions: ["sessions", "runtime:extend"],
    isolation: "in-process",
    activate(context) {
      const { services } = context;
      const book = new AttentionBook({ now: options.now ?? Date.now, debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS });
      const publish = (change: AttentionChange): void => {
        if (change.changed) context.emit(ATTENTION_EVENT, { items: book.list() });
        if (change.delivery) context.emit(NOTIFY_EVENT, change.delivery);
      };
      const raise = (threadId: string, reason: AttentionReason): void => {
        if (!threadId) return;
        const thread = services.thread(threadId);
        // A sub-agent reports to the thread that spawned it, not to the user.
        if (thread?.parentThreadId) return;
        const title = thread?.sessionName();
        publish(book.raise({
          threadId,
          reason,
          ...(title ? { title } : {}),
          ...(thread?.sessionFile ? { path: thread.sessionFile } : {}),
        }));
      };
      const stops = [
        services.registerTurnObserver({
          ended: async (sessionId, _turnId, outcome) => raise(sessionId, outcome === "failed" ? "failed" : "completed"),
        }),
        services.decorateUiPrompt((prompt) => raise(prompt.sessionId, promptReason(prompt))),
        services.registerThreadLifecycle({ threadDeleted: async (sessionId) => publish(book.drop(sessionId)) }),
        services.clients.observe({
          detached: () => {
            book.forgetClients();
            context.emit(PRESENCE_REQUEST_EVENT);
          },
        }),
      ];
      context.registerCommand("presence", (input): PresenceReply => {
        const presence = decodePresence(input);
        const change = book.report(presence.clientKey, presence);
        if (change.changed) context.emit(ATTENTION_EVENT, { items: book.list() });
        return { items: book.list(), ...(change.delivery ? { delivery: change.delivery } : {}) };
      }, { access: "read" });
      context.registerCommand(ATTENDED_COMMAND, () => ({ attended: book.attended() }), { access: "read", callers: ["tau.push"] });
      context.registerCommand("leave", (input) => {
        const clientKey = (input as { clientKey?: unknown } | null)?.clientKey;
        if (typeof clientKey === "string") book.leave(clientKey);
      }, { access: "read" });
      return () => { for (const stop of stops) stop(); };
    },
  };
}

export default createNotificationsHostExtension;
