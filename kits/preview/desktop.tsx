import { Globe } from "lucide-react";
import { errorMessage, type DesktopExtension, type WorkbenchActions } from "tau";
import { PREVIEW_HOST_EXTENSION_ID, PREVIEW_STATE_EVENT } from "./protocol.js";
import { PreviewPanel } from "./panel.js";
import { PREVIEW_PANEL, PreviewFollower, connectPreviewHost, isPreviewState, previewKit, previewStore } from "./store.js";

/**
 * Preview Kit: a browser panel the host draws over, and the tools that let the
 * agent open, read and drive the page it just changed.
 */
export const previewExtension: DesktopExtension = {
  id: PREVIEW_HOST_EXTENSION_ID,
  name: "Preview",
  activate(plugin) {
    const disconnect = connectPreviewHost(plugin.host);
    plugin.registerPanel({ id: PREVIEW_PANEL, label: "Preview", Icon: Globe, order: 40, Component: PreviewPanel });
    plugin.registerRegion({ id: "preview.follower", placement: "composer-above", order: 60, Component: PreviewFollower });
    plugin.host.onEvent(PREVIEW_STATE_EVENT, (payload) => { if (isPreviewState(payload)) previewStore.set(payload); });
    const open = async (url: string, app: WorkbenchActions): Promise<string | undefined> => {
      app.openPanel(PREVIEW_PANEL);
      if (!url) return undefined;
      try {
        await previewKit.open({ url });
      } catch (error) {
        return errorMessage(error);
      }
      return undefined;
    };
    plugin.registerCommand({ id: "preview.open", label: "Open preview panel", group: "Extensions", run: (app) => { void open("", app); } });
    plugin.registerSlashCommand({
      name: "preview",
      description: "Open a URL in the preview panel",
      argumentHint: "<url>",
      run: (args, app) => open(args.trim(), app),
    });
    plugin.registerKeybinding({ keys: "mod+shift+b", commandId: "preview.open" });
    return disconnect;
  },
};

export default previewExtension;
