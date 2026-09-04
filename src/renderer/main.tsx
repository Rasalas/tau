import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { createElectronHostClient } from "./host-client";
import { HostClientProvider, setHostClient } from "./host-client-context";
import { createLocalStorageAdapter, setClientStorage } from "./client-storage";
import { ClientStorageProvider } from "./client-storage-context";
import { createRendererServices } from "./renderer-services";
import { RendererServicesProvider } from "./renderer-services-context";
import "./styles.css";

// The one place a renderer module reads window.tau: everything else goes
// through HostClient, so a future transport only has to change this line.
const client = window.tau ? createElectronHostClient(window.tau) : undefined;
setHostClient(client);

// The browser storage adapter works in Electron's renderer like any browser; a
// future web or mobile client installs its own ClientStorage here instead.
const clientStorage = createLocalStorageAdapter();
setClientStorage(clientStorage);
const services = createRendererServices();

const root = createRoot(document.getElementById("root")!);
if (new URLSearchParams(window.location.search).has("rendererBenchmark")) {
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
