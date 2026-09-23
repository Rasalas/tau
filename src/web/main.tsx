import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createLocalStorageAdapter } from "../renderer/browser-storage";
import { setHostClient } from "../renderer/host-client-context";
import { createRendererServices } from "../renderer/renderer-services";
import { setClientStorage } from "../workbench/client-storage";
import { browserClientProfile } from "../workbench/client-profile";
import { createSocketHostClient } from "../workbench/host-connection-socket";
import { TokenGate } from "./TokenGate";
import { accessRefusal } from "../workbench/access-refusal";
import { WebWorkbench, webClientEnvironment } from "./WebWorkbench";
import { WEB_TOKEN_KEY, hostSocketUrl, resolveHostToken, takePairingCode } from "./host-token";
import "../renderer/styles.css";
import "../renderer/profile-compact.css";
import "./web.css";

/**
 * The browser client of a listening host. It has no preload bridge and no
 * `?host=`: the host that served this page is the host it talks to, over the
 * socket at the same origin.
 */
const storage = createLocalStorageAdapter();
setClientStorage(storage);
const root = createRoot(document.getElementById("root")!);
// Which client this is, decided once: a tab that starts phone-sized claims the
// compact profile, and a resize afterwards changes only the layout.
const profile = browserClientProfile(window.innerWidth, new URLSearchParams(window.location.search).get("profile"));

function showGate(notice?: string): void {
  root.render(<StrictMode>
    <TokenGate
      {...(notice ? { notice } : {})}
      onSubmit={(token) => { storage.set(WEB_TOKEN_KEY, token); connect(token); }}
    />
  </StrictMode>);
}

function connect(token: string): void {
  const host = createSocketHostClient(hostSocketUrl(window.location), token, {
    // A refused token cannot be repaired by retrying, so ask for another one.
    onUnauthorized: (reason) => { storage.remove(WEB_TOKEN_KEY); showGate(accessRefusal(reason)); },
    // An owner who rotated the host token from this tab keeps working after a reload.
    onTokenChanged: (next) => storage.set(WEB_TOKEN_KEY, next),
  });
  setHostClient(host.client);
  void host.connection.start(profile).catch(() => undefined);
  root.render(<StrictMode>
    <WebWorkbench
      client={host.client}
      storage={storage}
      services={createRendererServices()}
      environment={webClientEnvironment(profile)}
    />
  </StrictMode>);
}

// The pairing code is taken out of the address bar before anything renders.
void resolveHostToken(storage, takePairingCode(window))
  .then((token) => (token ? connect(token) : showGate()));
