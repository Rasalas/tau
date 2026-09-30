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
import { appleDynamicType, applyTypeScale, deviceClassFor } from "../../src/renderer/type-scale";
import { screenMinSide } from "../../src/renderer/use-layout-profile";
import { relayActivities } from "./activity-relay";
import { PUSH_RELAY_URL } from "../../kits/push/protocol";
import { Shell, type AppContext } from "./Shell";
import { HostBook } from "./hosts";
import { installActivityKey, nativeActivities, nativeDictation, browseHosts, createSocketBridge, deviceInfo, scanQrCode, secureStore, textScalePort, type DeviceInfo } from "./native";
import { androidFontScale } from "./text-scale";
import { linkRoute, readRoute } from "./routes";
import { createPushRegistrar, createRelayPort, sealedTapRoute, setPushRegistrar, tapRoute } from "./push";
import { PushKeys } from "./push-keys";
import { nativePushPort } from "./push-native";
import { nativeWakeSource } from "./wakes";

/** Outside a native shell (a browser during development) the plugin is missing. */
const BROWSER_DEVICE: DeviceInfo = { name: "Browser", model: "browser", platform: "ios", virtual: true };

async function boot(): Promise<void> {
  const [bridge, device] = await Promise.all([createSocketBridge(), deviceInfo().catch(() => BROWSER_DEVICE)]);
  // A phone or tablet reads larger, at the system's text size (ADR 0029).
  const system = device.platform === "android" ? await androidFontScale(textScalePort).catch(() => undefined) : appleDynamicType();
  applyTypeScale(deviceClassFor("compact", true, screenMinSide()), system);
  const push = nativePushPort(device.platform);
  const pushKeys = new PushKeys(secureStore);
  const book = new HostBook(secureStore);
  setPushRegistrar(createPushRegistrar(push, { relay: createRelayPort(), keys: pushKeys }));
  const context: AppContext = {
    activities: device.platform === "ios" ? relayActivities(nativeActivities, { url: PUSH_RELAY_URL, keys: pushKeys, installKey: installActivityKey, authorized: async (id) => Boolean(await book.token(id)) }) : nativeActivities,
    storage: createLocalStorageAdapter(),
    book,
    bridge,
    device,
    environment: { ...webClientEnvironment("compact"), ...(device.platform === "ios" ? { dictation: nativeDictation } : {}) },
    wakes: nativeWakeSource(App, Network),
    scan: scanQrCode,
    browse: (listener) => browseHosts(TAU_BONJOUR_TYPE, listener),
    navigate: (search) => window.location.replace(`${window.location.pathname}${search}`),
    subscribeToLinks: (listener) => {
      const handle = App.addListener("appUrlOpen", ({ url }) => { const route = linkRoute(url); if (route) listener(route); });
      // A tapped notification carries the same link, in the clear or sealed (a relay push on iOS).
      const stopTaps = push.onTap((data) => {
        const route = tapRoute(data);
        if (route) listener(route);
        else void sealedTapRoute(data, pushKeys).then((sealed) => { if (sealed) listener(sealed); });
      });
      return () => { stopTaps(); void handle.then((entry) => entry.remove()); };
    },
  };
  const launch = await App.getLaunchUrl().catch(() => undefined);
  const initial = (launch?.url ? linkRoute(launch.url) : undefined) ?? readRoute(window.location.search);
  createRoot(document.getElementById("root")!).render(<StrictMode><Shell context={context} initial={initial} /></StrictMode>);
  if (TAU_AUTOMATION_PORT) void import("./dev-automation").then(({ startAutomation }) => startAutomation(bridge, device, Number(TAU_AUTOMATION_PORT)));
}

/** The app could not even start: say so on screen instead of staying blank. */
function fatal(error: unknown): void {
  const root = document.getElementById("root")!;
  root.className = "shell-fatal";
  root.textContent = `Tau could not start: ${error instanceof Error ? error.message : String(error)}`;
}

window.addEventListener("error", (event) => { if (!document.getElementById("root")?.hasChildNodes()) fatal(event.error ?? event.message); });
void boot().catch(fatal);
