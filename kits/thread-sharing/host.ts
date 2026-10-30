import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { HostCommandError, type HostExtension, type HostExtensionServices, type HostExtensionCommandHandler, type HostExtensionCommandOptions } from "tau/host-extension";
import { GuestError, GuestShares } from "./store.js";
import { guestTranscript } from "./projection.js";
import { guestRoute } from "./http.js";
import { ADDRESS_REASON, GUEST_PATH, SHARING_EVENT, SHARING_ID, type GuestView } from "./protocol.js";
import { httpsOrigins } from "../_shared/https-origins.js";

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
const text = (input: unknown): string => typeof input === "string" ? input : "";
/** A missing or corrupt archive source cannot grant guest access. */
async function notArchived(services: HostExtensionServices, threadId: string): Promise<boolean> {
  try {
    const meta = JSON.parse(await readFile(join(services.stateDir, "..", "tau.thread-rail", "thread-meta.json"), "utf8")) as { threads?: Record<string, { archivedAt?: unknown; deletedAt?: unknown }> };
    return meta.threads?.[threadId]?.archivedAt === undefined && meta.threads?.[threadId]?.deletedAt === undefined;
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}
export default function createThreadSharing(): HostExtension {
  return {
    id: SHARING_ID, name: "Thread sharing", permissions: ["sessions", "network"],
    async activate(context) {
      const { services } = context;
      const register = (name: string, handler: HostExtensionCommandHandler, options: HostExtensionCommandOptions) => context.registerCommand(name, async (input, call) => {
        try { return await handler(input, call); }
        catch (error) { if (error instanceof GuestError) throw new HostCommandError(error.code); throw error; }
      }, options);
      const store = await GuestShares.open(join(services.stateDir, "guest-links.json"), { changed: () => context.emit(SHARING_EVENT) });
      const origins = () => httpsOrigins(services.network);
      const eligible = async (threadId: string) => (await services.sessions.list()).some((s) => s.sessionId === threadId && !s.parentThreadId) && await notArchived(services, threadId);
      const view = async (threadId: string, grantId: string): Promise<Omit<GuestView, "mode" | "expiresAt" | "suggestions">> => {
        const showToolOutput = store.outputAllowed(threadId, grantId);
        const thread = services.thread(threadId);
        if (!thread) {
          const cached = store.cached(threadId, grantId);
          if (cached) return cached;
          throw new GuestError(503, "unavailable");
        }
        if (thread.sessionId !== threadId || (showToolOutput && !thread.publicTools)) throw new GuestError(503, "unavailable");
        const messages = await thread.transcript();
        const tools = await thread.publicTools?.({ includeOutput: showToolOutput });
        const projection = { title: (thread.sessionName() || "Shared thread").slice(0, 200), machine: hostname().slice(0, 200), ...guestTranscript(messages, tools, showToolOutput) };
        await store.cache(threadId, projection, grantId);
        return projection;
      };
      const sweep = async () => {
        for (const link of store.list()) if (!await eligible(link.threadId)) await store.revoke(link.id);
      };
      register("state", async (_input, call) => {
        await sweep();
        return { enabled: store.allowed, owner: call.owner && !call.extension, available: !!context.observeExtensionEvent && !!services.network?.registerHttpRoute && origins().length > 0, toolOutputThreads: (await services.sessions.list()).filter((s) => !!services.thread(s.sessionId)?.publicTools).map((s) => s.sessionId), links: store.list() };
      }, { access: "read" });
      register("enable", async (input, call) => {
        if (!call.owner || call.extension || typeof record(input).enabled !== "boolean") throw new HostCommandError("Only this machine's own Tau window can manage guest links.");
        await store.setEnabled(record(input).enabled === true);
      }, { access: "owner" });
      register("create", async (input, call) => {
        if (!call.owner || call.extension) throw new HostCommandError("Create guest links in this machine's own Tau window.");
        if (!context.observeExtensionEvent || !services.network?.registerHttpRoute || !origins().length) throw new HostCommandError(ADDRESS_REASON);
        const fields = record(input);
        const threadId = text(fields.threadId);
        const thread = services.thread(threadId);
        if (!thread || thread.sessionId !== threadId || !await eligible(threadId)) throw new HostCommandError("Open an unarchived thread on this machine before sharing it.");
        if (fields.showToolOutput !== undefined && typeof fields.showToolOutput !== "boolean") throw new HostCommandError("Choose whether to show tool output.");
        if (fields.showToolOutput === true && !thread.publicTools) throw new HostCommandError("Tool output cannot be shared safely by this version.");
        const mode = fields.mode ?? "suggest";
        if (mode !== "watch" && mode !== "suggest") throw new HostCommandError("Choose Watch or Watch and suggest messages.");
        const result = await store.create(threadId, thread.sessionName() || "Shared thread", Number(fields.hours ?? 8), mode, fields.showToolOutput === true);
        try {
          await view(threadId, result.id);
          if (!await eligible(threadId) || !store.allowed) throw new GuestError(403, "ended");
          return { id: result.id, expiresAt: result.expiresAt, url: `${origins()[0]}${GUEST_PATH}#guest=${result.token}` };
        } catch (error) { await store.revoke(result.id); throw error; }
      }, { access: "owner" });
      register("revoke", async (input, call) => {
        if (!call.owner || call.extension) throw new HostCommandError("Only this machine's own Tau window can stop sharing.");
        await store.revoke(text(record(input).id));
      }, { access: "owner" });
      for (const action of ["send", "dismiss"] as const) register(action, async (input, call) => {
        if (call.extension) throw new HostCommandError("A person must review this guest suggestion.");
        const fields = record(input);
        await sweep();
        await store.moderate(text(fields.id), text(fields.suggestionId), action === "send", async (threadId, suggestion, authorized) => {
          if (!services.sessions.send || !store.allowed || !await eligible(threadId) || !authorized()) throw new HostCommandError("This guest link has ended.");
          // One explicit user action admits an ordinary queued message. No guest wake or auto-send.
          await services.sessions.send(threadId, suggestion.text, { delivery: "queue", beforeAdmit: () => { if (!authorized()) throw new HostCommandError("This guest link has ended."); }, attachments: suggestion.images.map((image, index) => ({ kind: "image", name: `Guest image ${index + 1}`, mimeType: image.mimeType, data: image.data, size: Buffer.from(image.data, "base64").length })) });
        });
      }, {});
      const end = (id: string) => { void store.revoke(id).catch(() => context.fail("Guest link revocation could not be saved.")); };
      const stopMeta = context.observeExtensionEvent?.("tau.thread-rail", "meta", (payload) => {
        const threads = record(record(payload).threads);
        for (const link of store.list()) if (record(threads[link.threadId]).archivedAt !== undefined) end(link.id);
      });
      const stopTrash = context.observeExtensionEvent?.("tau.thread-rail", "trash", (payload) => {
        if (!Array.isArray(payload)) return;
        const ids = new Set(payload.map((item: unknown) => text(record(item).sessionId)));
        for (const link of store.list()) if (ids.has(link.threadId)) end(link.id);
      });
      context.offer("tau.thread-rail/archive");
      context.registerCommand("thread-archived", async (input, call) => {
        if (call.extension !== "tau.thread-rail") throw new HostCommandError("This revocation belongs to the thread lifecycle.");
        await store.revokeThread(text(record(input).threadId));
      }, { callers: ["tau.thread-rail"] });
      const stopTurns = services.registerTurnObserver({ stopped: async (id) => { await store.revokeThread(id); return []; } });
      const stopLifecycle = services.registerThreadLifecycle({ beforeRemove: (id) => store.revokeThread(id), threadDeleted: (id) => store.revokeThread(id) });
      const stopRoute = services.network?.registerHttpRoute?.("guest", guestRoute({ store, origins, eligible, view }));
      return async () => { stopRoute?.(); stopMeta?.(); stopTrash?.(); stopTurns(); stopLifecycle(); await store.close(); };
    },
  };
}
