import { Globe } from "lucide-react";
import { cookieImportDialogs, createCookieImportLayer } from "./cookie-import-dialog.js";
import { errorMessage, type DesktopExtension, type WorkbenchActions } from "tau";
import { holdChipService } from "./attach.js";
import { followLinkTarget } from "./link-target.js";
import { createMiniPlayerRegion } from "./mini-player.js";
import { PREVIEW_SETTINGS, readLinkTarget, syncDefaults } from "./settings.js";
import { PreviewSettingsPage } from "./settings-page.js";
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
import { PreviewPanel } from "./panel.js";
import { COMPUTER_USE_SCREEN_SERVICE, type ComputerUseScreenService } from "./screen-protocol.js";
import { activeThread, holdScreenService, previewView, screenService } from "./screen-store.js";
import { PREVIEW_PANEL, PreviewFollower, connectPreviewHost, isPreviewState, previewKit, previewStore, readPreviewState, togglePreviewPanel, workbenchActions } from "./store.js";

/** T3 Code's `preview.focusUrl`: the panel's address field, its text selected. */
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
    plugin.registerPanel({ id: PREVIEW_PANEL, label: "Preview", Icon: Globe, order: 40, maximizable: true, profiles: ["desktop"], Component: PreviewPanel });
    plugin.registerRegion({ id: "preview.follower", placement: "composer-above", order: 60, profiles: ["desktop"], Component: PreviewFollower });
    plugin.registerRegion({ id: "preview.mini-player", placement: "composer-above", order: 61, profiles: ["desktop"], Component: createMiniPlayerRegion(plugin.preferences) });
    plugin.registerSettingsPage({
      id: "preview.settings",
      label: "Preview",
      Icon: Globe,
      order: 40,
      keywords: ["browser", "viewport", "zoom", "appearance", "dark mode", "links", "recording", "floating", "picture in picture"],
      profiles: ["desktop"],
      Component: PreviewSettingsPage,
    });
    plugin.host.onEvent(PREVIEW_STATE_EVENT, (payload) => { if (isPreviewState(payload)) previewStore.set(readPreviewState(payload)); });
    const stopDefaults = syncDefaults(plugin.preferences, (defaults) => previewKit.defaults(defaults));
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
        if (target.kind === "browser") {
          previewView.set("browser");
          app.openPanel(PREVIEW_PANEL);
          return;
        }
        const screen = screenService.get();
        if (!screen) throw new Error("No agent drives an app: Computer Use is off.");
        await screen.bringToFront(target.threadId);
      },
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
    plugin.registerCommand({ id: "preview.import-cookies", label: "Import cookies from a browser", group: "Extensions", run: () => { void cookieImportDialogs.open(); } });
    // Picks, annotations and recordings go to the composer as Composer Context's chips.
    plugin.useService<ComposerContextChips>(COMPOSER_CONTEXT_CHIPS_SERVICE, holdChipService);
    // The Screen view draws the window Computer Use's agent drives, while that kit is on.
    plugin.useService<ComputerUseScreenService>(COMPUTER_USE_SCREEN_SERVICE, holdScreenService);
    const stopFollowing = plugin.events.on("active-thread-changed", (event) => activeThread.set(event.sessionId));
    plugin.registerCommand({ id: "preview.open", label: "Open preview panel", group: "Extensions", run: (app) => { void open("", app); } });
    plugin.registerCommand({ id: "preview.toggle", label: "Toggle preview panel", group: "Extensions", run: (app) => togglePreviewPanel(app) });
    plugin.registerSlashCommand({
      name: "preview",
      description: "Open a URL in the preview panel",
      argumentHint: "<url>",
      run: (args, app) => open(args.trim(), app),
    });
    plugin.registerKeybinding({ keys: "mod+shift+b", commandId: "preview.open" });
    // T3 Code's chord for the same panel.
    plugin.registerKeybinding({ keys: "mod+shift+j", commandId: "preview.toggle" });
    plugin.registerCommand({ id: "preview.focus-url", label: "Focus the preview address", group: "Extensions", run: (app) => focusAddress(app) });
    plugin.registerKeybinding({ keys: "mod+l", commandId: "preview.focus-url", when: "previewFocus" });
    // T3 Code's preview.refresh and zoom commands. Their chords are the app menu's; the page takes them while it has the keyboard.
    const report = (app: Pick<WorkbenchActions, "notify">) => (error: unknown) => app.notify(errorMessage(error));
    plugin.registerCommand({ id: "preview.refresh", label: "Reload the preview", group: "Extensions", run: (app) => { void previewKit.navigate({ action: "reload" }).catch(report(app)); } });
    plugin.registerCommand({ id: "preview.zoom-in", label: "Zoom the preview in", group: "Extensions", run: (app) => { void previewKit.zoom({ step: "in" }).catch(report(app)); } });
    plugin.registerCommand({ id: "preview.zoom-out", label: "Zoom the preview out", group: "Extensions", run: (app) => { void previewKit.zoom({ step: "out" }).catch(report(app)); } });
    plugin.registerCommand({ id: "preview.reset-zoom", label: "Reset the preview's zoom", group: "Extensions", run: (app) => { void previewKit.zoom({ step: "reset" }).catch(report(app)); } });
    return () => {
      cookieImportDialogs.close();
      stopFollowing();
      stopDefaults();
      stopLinks();
      disconnect();
    };
  },
};

export default previewExtension;
