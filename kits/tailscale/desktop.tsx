import type { DesktopExtension } from "tau";
import { TAILSCALE_EXTENSION_ID } from "./protocol.js";
import { createTailscaleSection } from "./section.js";

/** What the Settings search finds in the section; each id is a row's anchor. */
export const TAILSCALE_ROWS = [
  { id: "setting-tailscale-https", label: "Tailscale HTTPS", keywords: ["tailscale", "https", "certificate", "serve", "tailnet"] },
  { id: "setting-tailscale-machine-name", label: "Machine name", keywords: ["tailscale", "rename", "magicdns", "hostname"] },
];

const tailscaleKitExtension: DesktopExtension = {
  id: TAILSCALE_EXTENSION_ID,
  name: "Tailscale",
  activate(context) {
    // Under Network access, where T3 Code keeps its Tailscale HTTPS row.
    return context.registerSettingsSection({
      id: "tailscale.connections",
      page: "connections",
      order: 10,
      profiles: ["desktop", "web", "compact"],
      rows: TAILSCALE_ROWS,
      Component: createTailscaleSection(context.host),
    });
  },
};

export default tailscaleKitExtension;
