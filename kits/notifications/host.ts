import { HostCommandError, type HostExtension } from "tau/host-extension";
import { AttentionBook, type AttentionChange } from "./attention.js";
import {
  ATTENDED_COMMAND,
  ATTENTION_EVENT,
  NOTIFICATIONS_EXTENSION_ID,
  NOTIFY_EVENT,
  PRESENCE_REQUEST_EVENT,
  promptReason,
  silenced,
  type AttentionReason,
  type Delivery,
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
      const now = options.now ?? Date.now;
      const book = new AttentionBook({ now, debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS });
      /** Open questions per thread; the last one answered clears the thread's question news. */
      const asking = new Map<string, number>();
      const values = async () => await services.settings?.().catch(() => undefined);
      // The badge counts every piece of news; what the user silenced reaches no client.
      const audible = async (delivery: Delivery | undefined): Promise<Delivery | undefined> => {
        if (!delivery) return undefined;
        const settings = await values();
        const items = delivery.items.filter((item) => !silenced(item.reason, settings, new Date(now())));
        return items.length ? { ...delivery, items } : undefined;
      };
      const publish = (change: AttentionChange): void => {
        if (change.changed) context.emit(ATTENTION_EVENT, { items: book.list() });
        // Without settings to read nothing is silenced, and the news goes out at once.
        if (change.delivery && !services.settings) context.emit(NOTIFY_EVENT, change.delivery);
        else void audible(change.delivery).then((delivery) => { if (delivery) context.emit(NOTIFY_EVENT, delivery); });
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
        services.decorateUiPrompt((prompt) => {
          raise(prompt.sessionId, promptReason(prompt));
          asking.set(prompt.sessionId, (asking.get(prompt.sessionId) ?? 0) + 1);
          return () => {
            const left = (asking.get(prompt.sessionId) ?? 1) - 1;
            if (left > 0) { asking.set(prompt.sessionId, left); return; }
            asking.delete(prompt.sessionId);
            publish(book.answered(prompt.sessionId));
          };
        }),
        services.registerThreadLifecycle({ threadDeleted: async (sessionId) => publish(book.drop(sessionId)) }),
        services.clients.observe({
          detached: () => {
            book.forgetClients();
            context.emit(PRESENCE_REQUEST_EVENT);
          },
        }),
      ];
      context.registerCommand("presence", async (input): Promise<PresenceReply> => {
        const presence = decodePresence(input);
        const change = book.report(presence.clientKey, presence);
        if (change.changed) context.emit(ATTENTION_EVENT, { items: book.list() });
        const delivery = await audible(change.delivery);
        return { items: book.list(), ...(delivery ? { delivery } : {}) };
      }, { access: "read" });
      // Push asks before it sends: `muted` when the user silenced this kind of news, or it is quiet hours.
      context.registerCommand(ATTENDED_COMMAND, async (input) => {
        const kind = (input as { kind?: AttentionReason } | null)?.kind;
        return { attended: book.attended(), muted: kind ? silenced(kind, await values(), new Date(now())) : false };
      }, { access: "read", callers: ["tau.push"] });
      context.registerCommand("leave", (input) => {
        const clientKey = (input as { clientKey?: unknown } | null)?.clientKey;
        if (typeof clientKey === "string") book.leave(clientKey);
      }, { access: "read" });
      return () => { for (const stop of stops) stop(); };
    },
  };
}

export default createNotificationsHostExtension;
