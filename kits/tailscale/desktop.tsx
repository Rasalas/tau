import type { DesktopExtension } from "tau";
import { TAILSCALE_EXTENSION_ID } from "./protocol.js";
import { createTailscaleSection } from "./section.js";

const tailscaleKitExtension: DesktopExtension = {
  id: TAILSCALE_EXTENSION_ID,
  name: "Tailscale",
  activate(context) {
    // Under Network access, where T3 Code keeps its Tailscale HTTPS row.
    return context.registerSettingsSection({ id: "tailscale.connections", page: "connections", order: 10, profiles: ["desktop", "web", "compact"], Component: createTailscaleSection(context.host) });
  },
};

export default tailscaleKitExtension;
