import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import type { HostClient } from "../workbench/host-client";
import { createElectronHostClient, createElectronHostTransport } from "./platform-electron";
import { createLocalStorageAdapter } from "./browser-storage";
import { createSocketHostClient } from "../workbench/host-connection-socket";
import { browserWakeSource } from "./browser-wakes";
import { HostConnection } from "../workbench/host-connection";
import { HostClientProvider, setHostClient } from "./host-client-context";
import { setClientStorage } from "../workbench/client-storage";
import { ClientStorageProvider } from "./client-storage-context";
import { createRendererServices } from "./renderer-services";
import { RendererServicesProvider } from "./renderer-services-context";
import { followThemePreference } from "./theme";
import { accessRefusal } from "../workbench/access-refusal";
import "./styles.css";
// Loaded after the desktop rules so the narrow client can narrow them.
import "./profile-compact.css";

const search = new URLSearchParams(window.location.search);
const remoteHost = search.get("host");

// The one place a renderer module reads window.tau: everything else goes
// through HostClient. `?host=ws://…` picks the socket transport instead; in a
// desktop window the bridge stays beside it and answers for this machine —
// the clipboard, image previews, the workbench build (ADR 0021).
function connect(): { client: HostClient; connection: HostConnection } | undefined {
  if (remoteHost) {
    const local = window.tau ? new HostConnection(createElectronHostTransport(window.tau)) : undefined;
    void local?.start().catch(() => undefined);
    const socket = createSocketHostClient(remoteHost, search.get("token") ?? undefined, {
      wakes: browserWakeSource(),
      onUnauthorized: (reason) => socket.connection.refuse(accessRefusal(reason)),
      // A reload keeps the address, so it carries the token a rotation gave this window.
      onTokenChanged: (token) => {
        const url = new URL(window.location.href);
        url.searchParams.set("token", token);
        window.history.replaceState(window.history.state, "", url);
      },
    }, local);
    // The window's process refused this host (its certificate is not the trusted one).
    const refused = search.get("hostRefused");
    if (refused) socket.connection.refuse(refused);
    return socket;
  }
  return window.tau ? createElectronHostClient(window.tau) : undefined;
}

const host = connect();
const client = host?.client;
setHostClient(client);
// Says hello before the first request, so the client knows where the push
// sequence starts and which capabilities this host has.
void host?.connection.start(search.get("profile") ?? "desktop", search.get("windowId") ?? undefined).catch(() => undefined);

// The browser storage adapter works in Electron's renderer like any browser; a
// future web or mobile client installs its own ClientStorage here instead.
// A page showing another machine keeps that host's state apart from this machine's (ADR 0025).
const clientStorage = createLocalStorageAdapter(search.get("environment") ?? undefined);
setClientStorage(clientStorage);
const services = createRendererServices();
// Before the first render: `index.html` paints the OS's theme, and a stored
// preference that disagrees has to win without a flash of the other one.
followThemePreference(services.preferences);

const root = createRoot(document.getElementById("root")!);
if (search.has("rendererBenchmark")) {
  void import("./RendererBenchmark").then(({ default: RendererBenchmark }) => root.render(<RendererBenchmark />));
} else {
  root.render(
    <StrictMode>
      <HostClientProvider client={client}>
        <ClientStorageProvider storage={clientStorage}>
          <RendererServicesProvider services={services}>
            <App />
          </RendererServicesProvider>
        </ClientStorageProvider>
      </HostClientProvider>
    </StrictMode>,
  );
}
