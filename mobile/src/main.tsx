import "../../src/renderer/tokens.css";
import "../../src/renderer/styles.css";
import "../../src/renderer/profile-compact.css";
import "./ui/shell.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@capacitor/app";
import { Network } from "@capacitor/network";
import { createLocalStorageAdapter } from "../../src/renderer/browser-storage";
import { webClientEnvironment } from "../../src/web/WebWorkbench";
import { Shell, type AppContext } from "./Shell";
import { HostBook } from "./hosts";
import { browseHosts, createSocketBridge, deviceInfo, scanQrCode, secureStore, type DeviceInfo } from "./native";
import { linkRoute, readRoute } from "./routes";
import { nativeWakeSource } from "./wakes";

/** Outside a native shell (a browser during development) the plugin is missing. */
const BROWSER_DEVICE: DeviceInfo = { name: "Browser", model: "browser", platform: "ios", virtual: true };

async function boot(): Promise<void> {
  const [bridge, device] = await Promise.all([createSocketBridge(), deviceInfo().catch(() => BROWSER_DEVICE)]);
  const context: AppContext = {
    storage: createLocalStorageAdapter(),
    book: new HostBook(secureStore),
    bridge,
    device,
    environment: webClientEnvironment("compact"),
    wakes: nativeWakeSource(App, Network),
    scan: scanQrCode,
    browse: (listener) => browseHosts(__TAU_BONJOUR_TYPE__, listener),
    navigate: (search) => window.location.replace(`${window.location.pathname}${search}`),
    subscribeToLinks: (listener) => {
      const handle = App.addListener("appUrlOpen", ({ url }) => { const route = linkRoute(url); if (route) listener(route); });
      return () => { void handle.then((entry) => entry.remove()); };
    },
  };
  const launch = await App.getLaunchUrl().catch(() => undefined);
  const initial = (launch?.url ? linkRoute(launch.url) : undefined) ?? readRoute(window.location.search);
  createRoot(document.getElementById("root")!).render(<StrictMode><Shell context={context} initial={initial} /></StrictMode>);
  if (__TAU_AUTOMATION__) void import("./dev-automation").then(({ startAutomation }) => startAutomation(bridge, device, Number(__TAU_AUTOMATION__)));
}

void boot();
