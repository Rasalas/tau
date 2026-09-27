import type { DesktopExtension, DesktopExtensionContext, UiSession, WorkbenchActions } from "tau";
import { TakeoverRowMark, createTakeoverRegion, putBack } from "./card.js";
import {
  COMPUTER_USE_SCREEN_SERVICE,
  PREVIEW_BROWSER_SERVICE,
  PREVIEW_COOKIE_IMPORT_SERVICE,
  PREVIEW_EXTENSION_ID,
  TAKEOVER_EXTENSION_ID,
  TAKEOVER_STATE_EVENT,
  WORKSPACE_STORE_SERVICE,
  readTakeovers,
  type ComputerUseScreenService,
  type PreviewBrowserService,
  type PreviewCookieImportService,
  type Takeover,
  type WorkspaceRowMarks,
} from "./protocol.js";
import { hold, services, takeovers, workbench } from "./store.js";

const PROFILES = ["desktop", "web", "compact"] as const;

/**
 * Tells the user of a new request where they would not see the card: a system
 * notification while the window lacks focus, a toast while another thread is
 * on screen. Each client decides for itself, so every device hears it.
 */
function createAnnouncer(context: DesktopExtensionContext) {
  const paths = new Map<string, string>();
  const toasts = new Map<string, { dismiss(): void }>();
  const focused = () => document.visibilityState !== "hidden" && document.hasFocus();
  const open = (takeover: Takeover) => {
    const path = paths.get(takeover.threadId) ?? takeover.sessionFile;
    const actions = workbench.get();
    if (path && actions) void actions.switchSession(path);
  };
  return {
    threadIndex(sessions: readonly UiSession[]) {
      paths.clear();
      for (const session of sessions) if (session.path) paths.set(session.id, session.path);
    },
    announce(takeover: Takeover) {
      const actions: WorkbenchActions | undefined = workbench.get();
      const title = takeover.title || "A thread";
      if (!focused()) {
        void context.attention?.notify({ title: `Your turn: ${title}`, body: takeover.reason, tag: `tau.takeover:${takeover.id}` })
          .then((outcome) => { if (outcome === "clicked") open(takeover); });
        return;
      }
      if (!actions || actions.activeThread()?.sessionId === takeover.threadId || !actions.toast) return;
      toasts.set(takeover.id, actions.toast({
        type: "info",
        title: `Your turn: ${title}`,
        description: takeover.reason,
        actions: [{ label: "Show", run: () => open(takeover) }],
      }));
    },
    ended(id: string) {
      toasts.get(id)?.dismiss();
      toasts.delete(id);
    },
  };
}

/**
 * Takeover: when an agent needs the user — a sign-in, a one-time code, a
 * captcha — the card above the composer brings the right page or window
 * forward, offers ways to the user's passwords and hands control back.
 */
const takeover: DesktopExtension = {
  id: TAKEOVER_EXTENSION_ID,
  name: "Takeover",
  activate(context: DesktopExtensionContext) {
    const announcer = createAnnouncer(context);
    let loaded = false;
    const apply = (next: Takeover[]) => {
      const before = new Set(takeovers.get().map((entry) => entry.id));
      const now = new Set(next.map((entry) => entry.id));
      takeovers.set(next);
      for (const id of before) if (!now.has(id)) { announcer.ended(id); putBack(id, workbench.get()); }
      if (loaded) for (const entry of next) if (!before.has(entry.id)) announcer.announce(entry);
      loaded = true;
    };
    const disposers: Array<() => void> = [];
    disposers.push(context.host.onEvent(TAKEOVER_STATE_EVENT, (payload) => apply(readTakeovers(payload))));
    void context.host.invoke("state").then((list) => { if (!loaded) apply(readTakeovers(list)); }, () => undefined);
    disposers.push(context.events.on("thread-index", (event) => announcer.threadIndex(event.threadIndex.sessions)));
    // A request that ended while the link was down sent its last list to nobody.
    disposers.push(context.events.on("host-connection", ({ state }) => {
      if (state === "connected") void context.host.invoke("state").then((list) => apply(readTakeovers(list)), () => undefined);
    }));

    const hosts = { own: context.host, preview: context.hostExtension(PREVIEW_EXTENSION_ID) };
    disposers.push(context.registerRegion({ id: "takeover.card", placement: "composer-above", order: 1, profiles: [...PROFILES], Component: createTakeoverRegion(hosts) }));
    disposers.push(context.useService<PreviewBrowserService>(PREVIEW_BROWSER_SERVICE, hold(services.preview)));
    disposers.push(context.useService<PreviewCookieImportService>(PREVIEW_COOKIE_IMPORT_SERVICE, hold(services.cookies)));
    disposers.push(context.useService<ComputerUseScreenService>(COMPUTER_USE_SCREEN_SERVICE, hold(services.screen)));
    disposers.push(context.useService<WorkspaceRowMarks>(WORKSPACE_STORE_SERVICE, (workspace) => workspace.registerThreadRowAccessory(TakeoverRowMark)));
    return () => {
      for (const dispose of disposers.reverse()) dispose();
      for (const entry of takeovers.get()) announcer.ended(entry.id);
      takeovers.set([]);
      workbench.set(undefined);
    };
  },
};

export default takeover;
