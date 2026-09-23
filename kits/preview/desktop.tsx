import { Globe } from "lucide-react";
import { errorMessage, type DesktopExtension, type WorkbenchActions } from "tau";
import { holdChipService } from "./attach.js";
import {
  COMPOSER_CONTEXT_CHIPS_SERVICE,
  PREVIEW_BROWSER_SERVICE,
  PREVIEW_HOST_EXTENSION_ID,
  PREVIEW_STATE_EVENT,
  type ComposerContextChips,
  type PreviewBrowserService,
} from "./protocol.js";
import { PreviewPanel } from "./panel.js";
import { PREVIEW_PANEL, PreviewFollower, connectPreviewHost, isPreviewState, previewKit, previewStore, togglePreviewPanel } from "./store.js";

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
    plugin.host.onEvent(PREVIEW_STATE_EVENT, (payload) => { if (isPreviewState(payload)) previewStore.set(payload); });
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
    });
    // Picks, annotations and recordings go to the composer as Composer Context's chips.
    plugin.useService<ComposerContextChips>(COMPOSER_CONTEXT_CHIPS_SERVICE, holdChipService);
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
    return disconnect;
  },
};

export default previewExtension;
