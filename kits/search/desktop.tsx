import type { DesktopExtension, RegionProps, PaletteSearchContext } from "tau";
import { ThreadSearchFeed } from "./thread-search-feed.js";
import { MessageIndexFeed } from "./index-feed.js";
import { createSearchSettings } from "./settings.js";
import { SearchDialogs, SearchDialogsLayer, type SearchHost } from "./dialogs.js";
import { fileItems, paletteThreads, projectItems, settle, threadContentItems, threadRequestItems, threadTitleItems } from "./palette-sources.js";
import { SEARCH_FILES_SERVICE, SEARCH_KIT_ID, WORKSPACE_STORE_SERVICE, type SearchFilesService, type WorkspaceStoreView } from "./protocol.js";

/** Content search waits this long after a keystroke before it asks the host to read the threads. */
export const THREAD_CONTENT_DELAY_MS = 150;
const FILES_DELAY_MS = 40;

const statusLetter = (status: string) => status === "added" || status === "untracked" ? "A" : status === "deleted" ? "D" : status === "renamed" ? "R" : "M";

/**
 * Search Kit's desktop half: ⇧⌘F searches the project's files, ⌘P picks one,
 * and the palette finds threads by title and by what was said in them, and
 * projects. The dialogs are drawn from a title-bar region over the window.
 */
export function createSearchExtension(options: { threadContentDelayMs?: number } = {}): DesktopExtension {
  const delay = options.threadContentDelayMs ?? THREAD_CONTENT_DELAY_MS;
  return {
    id: SEARCH_KIT_ID,
    name: "Search",
    activate(context) {
      const host: SearchHost = (command, input) => context.host.invoke(command, input) as never;
      const feed = new MessageIndexFeed(context.host);
      const messages = new ThreadSearchFeed(host, feed);
      const dialogs = new SearchDialogs();
      void feed.load();
      context.registerSettingsSection({ id: "search.settings", page: "threads", card: "search", profiles: ["desktop", "web", "compact"],
        rows: [{ id: "setting-index-message-text", label: "Index message text", keywords: ["search", "messages", "index"] }, { id: "setting-message-index", label: "Message index", keywords: ["search", "rebuild", "bytes"] }], Component: createSearchSettings(feed) });
      const archived = new Set<string>();
      let settlement: { get(id: string): { archivedAt?: number } | undefined } | undefined;
      context.useService<{ get(id: string): { archivedAt?: number } | undefined; subscribe(listener: () => void): () => void }>("tau.thread-rail/settlement", store => {
        settlement = store;
        const stop = store.subscribe(() => { archived.clear(); });
        return () => { stop(); if (settlement === store) settlement = undefined; };
      });
      const withArchives = (search: PaletteSearchContext): PaletteSearchContext => {
        archived.clear();
        for (const thread of search.index.threads) if (!thread.parentThreadId && settlement?.get(thread.id)?.archivedAt) archived.add(thread.id);
        return { ...search, index: { ...search.index, archivedThreadIds: [...archived] } };
      };
      // One window's searches cancel each other, never another window's.
      const channel = `window-${Math.random().toString(36).slice(2)}`;

      context.registerCommand({ id: "search.content", label: "Search in project…", group: "Search", access: "read", run: () => dialogs.toggle("content") });
      context.registerCommand({ id: "search.files", label: "Go to file…", group: "Search", access: "read", run: () => dialogs.toggle("files") });
      context.registerKeybinding({ keys: "mod+shift+f", commandId: "search.content" });
      context.registerKeybinding({ keys: "mod+p", commandId: "search.files" });

      const Layer = ({ actions }: RegionProps) => <SearchDialogsLayer dialogs={dialogs} host={host} channel={channel} actions={actions} />;
      context.registerRegion({ id: "search.dialogs", placement: "title-bar", profiles: ["desktop", "web", "compact"], Component: Layer });
      context.provideService<SearchFilesService>(SEARCH_FILES_SERVICE, { pickFile: (onPick) => dialogs.pickFile(onPick) });

      // The transcript's ⌘F reaches the turns the window has not loaded through the runtime's whole transcript.
      context.registerTranscriptFinder({
        id: "search.transcript",
        profiles: ["desktop", "web", "compact"],
        find: ({ sessionId, query, mode }) => host("find-in-thread", { sessionId, query, ...(mode ? { mode } : {}) }),
      });

      context.registerPaletteSource({ id: "search.threads", label: "Threads", order: 10, scope: "threads", search: (query, search) => { const scoped = withArchives(search); return threadTitleItems(query, scoped).filter(item => query.trim().length < 3 || !archived.has(item.id)); } });
      context.registerPaletteSource({
        id: "search.thread-content",
        label: "Threads",
        order: 20,
        scope: "threads",
        status: (query, search) => query.trim().length >= 3 && (!search.scope || search.scope === "all" || search.scope === "threads") ? messages.notice() : undefined,
        subscribeStatus: messages.subscribe,
        search: async (query, input) => {
          const search = withArchives(input);
          const hiddenArchived = new Set(search.index.archivedThreadIds);
          if (query.trim().length < 3) return [];
          await settle(delay, search.signal);
          if (search.signal.aborted) return [];
          const titled = new Set(threadTitleItems(query, search).map((item) => item.id));
          const sessionIds = paletteThreads(search).filter((thread) => !titled.has(thread.id)).map((thread) => thread.id);
          if (!sessionIds.length) return threadTitleItems(query, search).filter(item => hiddenArchived.has(item.id));
          const request = { query, limit: 12, sessionIds, archivedSessionIds: [...hiddenArchived], channel: `${channel}-threads`, ...(search.index.activeThreadId ? { activeSessionId: search.index.activeThreadId } : {}) };
          const matches = await messages.search(request, search);
          const items = threadContentItems(matches, search, titled, query);
          const partial = messages.partial();
          if (partial) items.push({ id: "search.partial", label: "Partial thread search", detail: partial, access: "read" });
          return [...items.filter(item => !hiddenArchived.has(item.id)), ...threadTitleItems(query, search).filter(item => hiddenArchived.has(item.id)), ...items.filter(item => hiddenArchived.has(item.id))];
        },
      });
      // `#95`, `acme/tau#95`, a request URL or a branch finds the threads that link that request.
      context.registerPaletteSource({
        id: "search.thread-requests",
        label: "Threads",
        order: 12,
        scope: "threads",
        search: async (query, search) => {
          if (query.trim().length < 2) return [];
          await settle(delay, search.signal);
          if (search.signal.aborted) return [];
          const titled = new Set(threadTitleItems(query, search).map((item) => item.id));
          const sessionIds = paletteThreads(search).filter((thread) => !titled.has(thread.id)).map((thread) => thread.id);
          if (!sessionIds.length) return [];
          const matches = await host("thread-requests", { query, limit: 12, sessionIds });
          return threadRequestItems(matches, search, titled);
        },
      });
      context.registerPaletteSource({ id: "search.projects", label: "Projects", order: 30, search: projectItems });

      // The files of the thread on screen; the heading names its branch, so it registers again when that moves.
      let status = new Map<string, string>();
      let dropFiles: (() => void) | undefined;
      const registerFiles = (branch?: string) => {
        dropFiles?.();
        dropFiles = context.registerPaletteSource({
          id: "search.files",
          label: branch ? `Files · in ${branch}` : "Files",
          order: 15,
          scope: "files",
          search: async (query, search) => {
            const cwd = search.actions.activeThread()?.cwd;
            if (!cwd || (!query.trim() && search.scope !== "files")) return [];
            await settle(query ? FILES_DELAY_MS : 0, search.signal);
            if (search.signal.aborted) return [];
            return fileItems((await host("files", { cwd, query: query.trim(), limit: 60 })).files, status);
          },
        });
      };
      registerFiles();

      // A Git status push means files may have come or gone: the picker reads the list again.
      context.useService<WorkspaceStoreView>(WORKSPACE_STORE_SERVICE, (store) => {
        let changes: ReturnType<WorkspaceStoreView["getSnapshot"]>["changes"];
        const read = () => {
          const state = store.getSnapshot();
          if (state.changes === changes) return false;
          const branch = changes?.branch;
          changes = state.changes;
          status = new Map(changes?.files?.map((file) => [file.path, statusLetter(file.status)]));
          if (changes?.branch !== branch) registerFiles(changes?.branch);
          return true;
        };
        read();
        return store.subscribe(() => {
          if (read()) void host("invalidate", store.getSnapshot().cwd ? { cwd: store.getSnapshot().cwd } : {}).catch(() => undefined);
        });
      });
      context.events.on("workspace-changed", () => { void host("invalidate", {}).catch(() => undefined); });
      return () => { dialogs.close(); dropFiles?.(); messages.dispose(); feed.dispose(); void host("thread-search-cancel", { channel: `${channel}-threads` }).catch(() => undefined); };
    },
  };
}

export default createSearchExtension();
