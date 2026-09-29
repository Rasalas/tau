import { lazy } from "react";
import { Globe } from "lucide-react";
import { cookieImportDialogs, createCookieImportLayer } from "./cookie-import-dialog.js";
import { errorMessage, type DesktopExtension, type WorkbenchActions } from "tau";
import { holdChipService } from "./attach.js";
import { followLinkTarget } from "./link-target.js";
import { createMiniPlayerRegion } from "./mini-player.js";
import { PREVIEW_SETTINGS, readLinkTarget } from "./settings.js";
import { PREVIEW_SETTINGS_ROWS, PreviewSettingsPage } from "./settings-page.js";
import {
  COMPOSER_CONTEXT_CHIPS_SERVICE,
  PREVIEW_BROWSER_SERVICE,
  PREVIEW_COOKIE_IMPORT_SERVICE,
  PREVIEW_HOST_EXTENSION_ID,
  PREVIEW_STATE_EVENT,
  type ComposerContextChips,
  type PreviewBrowserService,
  type PreviewCookieImportService,
} from "./protocol.js";
import { DesktopPreviewPanel, createMiniBarRegion, createRemotePreviewPanel } from "./remote-panel.js";
import { watchFrames, type LiveFrameAnswer, type LiveFrameSource } from "./live-frames.js";
import { COMPUTER_USE_SCREEN_SERVICE, type ComputerUseScreenService } from "./screen-protocol.js";
import { activeThread, holdScreenService, previewView, screenService } from "./screen-store.js";
import { followHostMachine } from "./machine.js";
import { PREVIEW_PANEL, PreviewFollower, connectPreviewHost, drawsFrames, isPreviewState, previewKit, previewStore, readPreviewState, togglePreviewPanel, workbenchActions } from "./store.js";

// Loaded the first time a tab looks in on a thread of another machine.
const LookInPreview = lazy(() => import("./look-in.js"));

const pageFrames: LiveFrameSource = async (maxWidth, since) =>
  await previewKit["live-frame"]({ maxWidth, ...(since ? { since } : {}) }) as LiveFrameAnswer;

/** Focuses the panel's address field, its text selected. */
function focusAddress(app: Pick<WorkbenchActions, "openPanel">): void {
  app.openPanel(PREVIEW_PANEL);
  requestAnimationFrame(() => {
    const field = document.querySelector<HTMLInputElement>('.preview-panel input[aria-label="Preview address"]');
    field?.focus();
    field?.select();
  });
}

/**
 * Preview Kit: a browser panel the host draws over, and the tools that let the
 * agent open, read and drive the page it just changed.
 */
export const previewExtension: DesktopExtension = {
  id: PREVIEW_HOST_EXTENSION_ID,
  name: "Preview",
  activate(plugin) {
    const disconnect = connectPreviewHost(plugin.host);
    const stopMachine = followHostMachine(plugin.environments);
    plugin.registerPanel({ id: PREVIEW_PANEL, label: "Preview", Icon: Globe, order: 40, width: "wide", maximizable: true, profiles: ["desktop"], Component: DesktopPreviewPanel });
    // Elsewhere the page stays on the host: a browser and a phone show its frames and drive it from there.
    plugin.registerPanel({ id: PREVIEW_PANEL, label: "Preview", Icon: Globe, order: 40, width: "wide", maximizable: true, profiles: ["web"], Component: createRemotePreviewPanel(false) });
    plugin.registerPanel({ id: PREVIEW_PANEL, label: "Preview", Icon: Globe, order: 40, width: "wide", maximizable: true, profiles: ["compact"], Component: createRemotePreviewPanel(true) });
    // A tab that looks in on another machine's thread shows that machine's page, small and view only.
    plugin.registerRegion({ id: "preview.look-in", placement: "look-in", order: 40, profiles: ["desktop"], Component: LookInPreview });
    plugin.registerRegion({ id: "preview.follower", placement: "composer-above", order: 60, profiles: ["desktop"], Component: PreviewFollower });
    plugin.registerRegion({ id: "preview.mini-player", placement: "composer-above", order: 61, profiles: ["desktop", "web"], Component: createMiniPlayerRegion(plugin.preferences) });
    plugin.registerRegion({ id: "preview.mini-bar", placement: "composer-above", order: 61, profiles: ["compact"], Component: createMiniBarRegion(plugin.preferences) });
    plugin.registerSettingsPage({
      id: "preview.settings",
      label: "Preview",
      description: "The browser beside a thread: the size and zoom a new page opens at, where links open, recordings and the floating preview.",
      group: "projects",
      Icon: Globe,
      order: 40,
      keywords: ["browser", "viewport", "zoom", "appearance", "dark mode", "links", "recording", "floating", "picture in picture"],
      rows: PREVIEW_SETTINGS_ROWS,
      // Most rows take a project override; without the scope crumb Settings would edit this machine only.
      scope: "both",
      profiles: ["desktop"],
      Component: PreviewSettingsPage,
    });
    plugin.host.onEvent(PREVIEW_STATE_EVENT, (payload) => { if (isPreviewState(payload)) previewStore.set(readPreviewState(payload)); });
    const open = async (url: string, app: Pick<WorkbenchActions, "openPanel">): Promise<string | undefined> => {
      app.openPanel(PREVIEW_PANEL);
      if (!url) return undefined;
      try {
        await previewKit.open({ url });
      } catch (error) {
        return errorMessage(error);
      }
      return undefined;
    };
    plugin.provideService<PreviewBrowserService>(PREVIEW_BROWSER_SERVICE, {
      open: async (url, app) => {
        const failure = await open(url, app);
        if (failure) throw new Error(failure);
      },
      jump: async (target, app) => {
        // Away from the host's machine, raising a window there helps nobody: the Preview here shows and drives it.
        if (target.kind === "browser" || drawsFrames()) {
          previewView.set(target.kind === "browser" ? "browser" : "screen");
          app.openPanel(PREVIEW_PANEL);
          return;
        }
        const screen = screenService.get();
        if (!screen) throw new Error("No agent drives an app: Computer Use is off.");
        await screen.bringToFront(target.threadId);
      },
      watch: (target, maxWidth, onFrame) => {
        let source: LiveFrameSource | undefined = pageFrames;
        if (target.kind === "app") {
          const screen = screenService.get();
          source = screen?.viewFrame ? async (width, since) => await screen.viewFrame!(target.threadId, width, since) ?? null : undefined;
        }
        if (!source) {
          onFrame(undefined);
          return () => undefined;
        }
        return watchFrames(source, maxWidth, (picture) => onFrame(picture ? { url: picture.url, width: picture.width, height: picture.height } : undefined));
      },
      remote: () => drawsFrames(),
    });
    // A plain click on a link in a reply opens it here when Settings → Preview says so.
    const stopLinks = followLinkTarget(
      () => readLinkTarget(plugin.preferences.value(PREVIEW_HOST_EXTENSION_ID, PREVIEW_SETTINGS.linkTarget)),
      (url) => {
        previewView.set("browser");
        void open(url, workbenchActions.get() ?? { openPanel: () => undefined });
      },
    );
    // Nothing imports cookies without the user's click on Import in this dialog.
    plugin.registerRegion({ id: "preview.cookie-import", placement: "title-bar", profiles: ["desktop"], Component: createCookieImportLayer(cookieImportDialogs, previewKit) });
    plugin.provideService<PreviewCookieImportService>(PREVIEW_COOKIE_IMPORT_SERVICE, {
      importSite: (request) => cookieImportDialogs.open({ site: request.site, ...(request.profile ? { profile: request.profile } : {}) }),
    });
    plugin.registerCommand({ id: "preview.import-cookies", label: "Import cookies from a browser", group: "Extensions", access: "write", run: () => { void cookieImportDialogs.open(); } });
    // Picks, annotations and recordings go to the composer as Composer Context's chips.
    plugin.useService<ComposerContextChips>(COMPOSER_CONTEXT_CHIPS_SERVICE, holdChipService);
    // The Screen view draws the window Computer Use's agent drives, while that kit is on.
    plugin.useService<ComputerUseScreenService>(COMPUTER_USE_SCREEN_SERVICE, holdScreenService);
    const stopFollowing = plugin.events.on("active-thread-changed", (event) => activeThread.set(event.sessionId));
    plugin.registerCommand({ id: "preview.open", label: "Open preview panel", group: "Extensions", access: "read", run: (app) => { void open("", app); } });
    plugin.registerCommand({ id: "preview.toggle", label: "Toggle preview panel", group: "Extensions", access: "read", run: (app) => togglePreviewPanel(app) });
    plugin.registerSlashCommand({
      name: "preview",
      description: "Open a URL in the preview panel",
      argumentHint: "<url>",
      run: (args, app) => open(args.trim(), app),
    });
    plugin.registerKeybinding({ keys: "mod+shift+b", commandId: "preview.open" });
    // The chord other workbenches use for the same panel.
    plugin.registerKeybinding({ keys: "mod+shift+j", commandId: "preview.toggle" });
    plugin.registerCommand({ id: "preview.focus-url", label: "Focus the preview address", group: "Extensions", access: "write", run: (app) => focusAddress(app) });
    plugin.registerKeybinding({ keys: "mod+l", commandId: "preview.focus-url", when: "previewFocus" });
    // Reload and zoom for the page. Their chords are the app menu's; the page takes them while it has the keyboard.
    const report = (app: Pick<WorkbenchActions, "notify">) => (error: unknown) => app.notify(errorMessage(error));
    plugin.registerCommand({ id: "preview.refresh", label: "Reload the preview", group: "Extensions", access: "write", run: (app) => { void previewKit.navigate({ action: "reload" }).catch(report(app)); } });
    plugin.registerCommand({ id: "preview.zoom-in", label: "Zoom the preview in", group: "Extensions", access: "write", run: (app) => { void previewKit.zoom({ step: "in" }).catch(report(app)); } });
    plugin.registerCommand({ id: "preview.zoom-out", label: "Zoom the preview out", group: "Extensions", access: "write", run: (app) => { void previewKit.zoom({ step: "out" }).catch(report(app)); } });
    plugin.registerCommand({ id: "preview.reset-zoom", label: "Reset the preview's zoom", group: "Extensions", access: "write", run: (app) => { void previewKit.zoom({ step: "reset" }).catch(report(app)); } });
    return () => {
      cookieImportDialogs.close();
      stopFollowing();
      stopLinks();
      stopMachine();
      disconnect();
    };
  },
};

export default previewExtension;
