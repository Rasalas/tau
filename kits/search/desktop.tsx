import type { DesktopExtension, RegionProps } from "tau";
import { SearchDialogs, SearchDialogsLayer, type SearchHost } from "./dialogs.js";
import { projectItems, settle, threadContentItems, threadTitleItems } from "./palette-sources.js";
import { SEARCH_KIT_ID, WORKSPACE_STORE_SERVICE, type WorkspaceStoreView } from "./protocol.js";

/** Content search waits this long after a keystroke before it asks the host to read the threads. */
export const THREAD_CONTENT_DELAY_MS = 150;

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
      const dialogs = new SearchDialogs();
      // One window's searches cancel each other, never another window's.
      const channel = `window-${Math.random().toString(36).slice(2)}`;

      context.registerCommand({ id: "search.content", label: "Search in project…", group: "Search", access: "read", run: () => dialogs.toggle("content") });
      context.registerCommand({ id: "search.files", label: "Go to file…", group: "Search", access: "read", run: () => dialogs.toggle("files") });
      context.registerKeybinding({ keys: "mod+shift+f", commandId: "search.content" });
      context.registerKeybinding({ keys: "mod+p", commandId: "search.files" });

      const Layer = ({ actions }: RegionProps) => <SearchDialogsLayer dialogs={dialogs} host={host} channel={channel} actions={actions} />;
      context.registerRegion({ id: "search.dialogs", placement: "title-bar", profiles: ["desktop", "web"], Component: Layer });

      context.registerPaletteSource({ id: "search.threads", label: "Threads", order: 10, search: threadTitleItems });
      context.registerPaletteSource({
        id: "search.thread-content",
        label: "In threads",
        order: 20,
        search: async (query, search) => {
          if (query.trim().length < 3) return [];
          await settle(delay, search.signal);
          if (search.signal.aborted) return [];
          const matches = await host("threads", { query, limit: 12, ...(search.index.activeThreadId ? { activeSessionId: search.index.activeThreadId } : {}) });
          const titled = new Set(threadTitleItems(query, search).map((item) => item.id));
          return threadContentItems(matches, search, titled);
        },
      });
      context.registerPaletteSource({ id: "search.projects", label: "Projects", order: 30, search: projectItems });

      // A Git status push means files may have come or gone: the picker reads the list again.
      context.useService<WorkspaceStoreView>(WORKSPACE_STORE_SERVICE, (store) => {
        let changes = store.getSnapshot().changes;
        return store.subscribe(() => {
          const state = store.getSnapshot();
          if (state.changes === changes) return;
          changes = state.changes;
          void host("invalidate", state.cwd ? { cwd: state.cwd } : {}).catch(() => undefined);
        });
      });
      context.events.on("workspace-changed", () => { void host("invalidate", {}).catch(() => undefined); });
      return () => dialogs.close();
    },
  };
}

export default createSearchExtension();
