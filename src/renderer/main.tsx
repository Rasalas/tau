import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { createElectronHostClient } from "./host-client";
import { HostClientProvider, setHostClient } from "./host-client-context";
import "./styles.css";

// The one place a renderer module reads window.tau: everything else goes
// through HostClient, so a future transport only has to change this line.
const client = window.tau ? createElectronHostClient(window.tau) : undefined;
setHostClient(client);

const root = createRoot(document.getElementById("root")!);
if (new URLSearchParams(window.location.search).has("rendererBenchmark")) {
  void import("./RendererBenchmark").then(({ default: RendererBenchmark }) => root.render(<RendererBenchmark />));
} else {
  root.render(<StrictMode><HostClientProvider client={client}><App /></HostClientProvider></StrictMode>);
}
