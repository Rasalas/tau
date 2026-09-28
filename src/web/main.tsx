import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createLocalStorageAdapter } from "../renderer/browser-storage";
import { setHostClient } from "../renderer/host-client-context";
import { createRendererServices } from "../renderer/renderer-services";
import { primaryPointerIsTouch } from "../renderer/touch-input";
import { setClientStorage } from "../workbench/client-storage";
import { browserClientProfile } from "../workbench/client-profile";
import { createSocketHostClient } from "../workbench/host-connection-socket";
import { browserWakeSource } from "../renderer/browser-wakes";
import { PairingWait, TokenGate } from "./TokenGate";
import { accessRefusal } from "../workbench/access-refusal";
import { watchChunkLoadErrors } from "../renderer/chunk-reload";
import { pairWithHost } from "../workbench/host-pairing";
import { WebWorkbench, webClientEnvironment } from "./WebWorkbench";
import { WEB_TOKEN_KEY, hostSocketUrl, pairingNotice, takePairingCode } from "./host-token";
import "../renderer/styles.css";
import "../renderer/profile-compact.css";
import "./web.css";

/**
 * The browser client of a listening host. It has no preload bridge and no
 * `?host=`: the host that served this page is the host it talks to, over the
 * socket at the same origin.
 */
// A host update removes this page's chunks; one reload fetches the new build.
watchChunkLoadErrors();
const storage = createLocalStorageAdapter();
setClientStorage(storage);
const root = createRoot(document.getElementById("root")!);
// Which client this is, decided once: a tab that starts phone-sized, or on a
// touch screen, claims the compact profile; a resize afterwards changes only the layout.
const profile = browserClientProfile(window.innerWidth, new URLSearchParams(window.location.search).get("profile"), primaryPointerIsTouch());

function showGate(notice?: string): void {
  root.render(<StrictMode>
    <TokenGate
      {...(notice ? { notice } : {})}
      onSubmit={(token) => { storage.set(WEB_TOKEN_KEY, token); connect(token); }}
      onAsk={() => pair()}
    />
  </StrictMode>);
}

/**
 * Asks the host to let this browser in, with the link's code or without one,
 * and waits while its owner compares the code on both screens (ADR 0024).
 */
function pair(code?: string): void {
  const cancel = new AbortController();
  const wait = (verification?: string) => root.render(<StrictMode>
    <PairingWait {...(verification ? { verification } : {})} onCancel={() => cancel.abort()} />
  </StrictMode>);
  wait();
  void pairWithHost({
    url: hostSocketUrl(window.location),
    ...(code ? { code } : {}),
    signal: cancel.signal,
    onWaiting: ({ verification }) => wait(verification),
  }).then((result) => {
    if (result.state === "approved") {
      storage.set(WEB_TOKEN_KEY, result.token);
      connect(result.token);
      return;
    }
    // A browser that paired before keeps working when a second link fails.
    const stored = storage.get(WEB_TOKEN_KEY);
    if (stored && result.state === "refused" && result.reason === "unknown-code") connect(stored);
    else showGate(cancel.signal.aborted ? undefined : pairingNotice(result));
  });
}

function connect(token: string): void {
  const host = createSocketHostClient(hostSocketUrl(window.location), token, {
    wakes: browserWakeSource(),
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
      environment={{ ...webClientEnvironment(profile), servedByHost: true }}
    />
  </StrictMode>);
}

// The pairing code is taken out of the address bar before anything renders.
const code = takePairingCode(window);
const stored = storage.get(WEB_TOKEN_KEY);
if (code) pair(code);
else if (stored) connect(stored);
else showGate();
