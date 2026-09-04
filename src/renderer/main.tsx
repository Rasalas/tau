import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { createElectronHostClient, type HostClient } from "./host-client";
import { createSocketHostClient } from "./host-connection-socket";
import type { HostConnection } from "./host-connection";
import { HostClientProvider, setHostClient } from "./host-client-context";
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

const root = createRoot(document.getElementById("root")!);
if (search.has("rendererBenchmark")) {
  void import("./RendererBenchmark").then(({ default: RendererBenchmark }) => root.render(<RendererBenchmark />));
} else {
  root.render(<StrictMode><HostClientProvider client={client}><App /></HostClientProvider></StrictMode>);
}
