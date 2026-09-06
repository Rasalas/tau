import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import type { HostClient } from "../workbench/host-client";
import { createElectronHostClient, createLocalStorageAdapter } from "./platform-electron";
import { createSocketHostClient } from "../workbench/host-connection-socket";
import type { HostConnection } from "../workbench/host-connection";
import { HostClientProvider, setHostClient } from "./host-client-context";
import { setClientStorage } from "../workbench/client-storage";
import { ClientStorageProvider } from "./client-storage-context";
import { createRendererServices } from "./renderer-services";
import { RendererServicesProvider } from "./renderer-services-context";
import "./styles.css";

const search = new URLSearchParams(window.location.search);
const remoteHost = search.get("host");

// The one place a renderer module reads window.tau: everything else goes
// through HostClient. `?host=ws://…` picks the socket transport instead.
function connect(): { client: HostClient; connection: HostConnection } | undefined {
  if (remoteHost) return createSocketHostClient(remoteHost, search.get("token") ?? undefined);
  return window.tau ? createElectronHostClient(window.tau) : undefined;
}

const host = connect();
const client = host?.client;
setHostClient(client);
// Says hello before the first request, so the client knows where the push
// sequence starts and which capabilities this host has.
void host?.connection.start().catch(() => undefined);

// The browser storage adapter works in Electron's renderer like any browser; a
// future web or mobile client installs its own ClientStorage here instead.
const clientStorage = createLocalStorageAdapter();
setClientStorage(clientStorage);
const services = createRendererServices();

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
