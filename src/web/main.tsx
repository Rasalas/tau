import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createLocalStorageAdapter } from "../renderer/browser-storage";
import { setHostClient } from "../renderer/host-client-context";
import { createRendererServices } from "../renderer/renderer-services";
import { primaryPointerIsTouch } from "../renderer/touch-input";
import { appleDynamicType, applyTypeScale, deviceClassFor } from "../renderer/type-scale";
import { screenMinSide } from "../renderer/use-layout-profile";
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
import type { BrowserConnectSession } from "./connect/offer";

/**
 * The browser client pairs with its serving host, or with a host identified
 * by a pinned Tau Connect offer. Neither route takes credentials from a query.
 */
// A host update removes this page's chunks; one reload fetches the new build.
watchChunkLoadErrors();
const storage = createLocalStorageAdapter();
setClientStorage(storage);
const root = createRoot(document.getElementById("root")!);
let currentConnection: ReturnType<typeof createSocketHostClient>["connection"] | undefined;
let currentPairing: AbortController | undefined;
let connectSession: BrowserConnectSession | undefined;
let attempt = 0;
window.addEventListener("pagehide", () => { currentPairing?.abort(); currentConnection?.close(); });
// Which client this is, decided once: a tab that starts phone-sized, or on a
// touch screen, claims the compact profile; a resize afterwards changes only the layout.
const profile = browserClientProfile(window.innerWidth, new URLSearchParams(window.location.search).get("profile"), primaryPointerIsTouch());
// A phone or tablet reads larger, and at the system's text size where the browser says it (ADR 0029).
const device = deviceClassFor(profile, primaryPointerIsTouch(), screenMinSide());
applyTypeScale(device, device === "desktop" ? undefined : appleDynamicType());

function showGate(notice?: string): void {
  root.render(<StrictMode>
    <TokenGate
      {...(notice ? { notice } : {})}
      onSubmit={(token) => { currentPairing?.abort(); attempt++; connectSession = undefined; storage.set(WEB_TOKEN_KEY, token); connect(token); }}
      onAsk={() => pair()}
      onConnect={(link) => { void pairConnect(link); }}
    />
  </StrictMode>);
}

/**
 * Asks the host to let this browser in, with the link's code or without one,
 * and waits while its owner compares the code on both screens (ADR 0024).
 */
function pair(code?: string): void {
  currentPairing?.abort(); currentConnection?.close(); connectSession = undefined; const ownAttempt = ++attempt;
  const cancel = new AbortController();
  currentPairing = cancel;
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
    if (ownAttempt !== attempt) return;
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

function connect(token: string, createSocket?: import("../workbench/host-connection-socket").SocketTransportOptions["createSocket"]): void {
  currentConnection?.close();
  const host = createSocketHostClient(hostSocketUrl(window.location), token, {
    ...(createSocket ? { createSocket } : {}),
    wakes: browserWakeSource(),
    // A refused token cannot be repaired by retrying, so ask for another one.
    onUnauthorized: (reason) => { storage.remove(WEB_TOKEN_KEY); if (connectSession) void import("./connect/storage").then(({ BrowserConnectStorage }) => new BrowserConnectStorage().remove()).catch(() => undefined); connectSession = undefined; showGate(accessRefusal(reason)); },
    // An owner who rotated the host token from this tab keeps working after a reload.
    onTokenChanged: (next) => {
      if (connectSession) { connectSession = { ...connectSession, token: next }; const session = connectSession; void import("./connect/storage").then(({ BrowserConnectStorage }) => new BrowserConnectStorage().save(session, () => connectSession === session)).catch((error: unknown) => { if (connectSession === session) showGate(String(error)); }); }
      else storage.set(WEB_TOKEN_KEY, next);
    },
  });
  currentConnection = host.connection;
  setHostClient(host.client);
  void host.connection.start(profile).catch(() => undefined);
  root.render(<StrictMode>
    <WebWorkbench
      client={host.client}
      storage={storage}
      services={createRendererServices(connectSession ? [{ id: "tau.browser-connect", name: "Tau Connect", activate: (context) => context.registerCommand({ id: "tau.browser-connect.forget", label: "Forget Tau Connect", group: "Connections", access: "read", destructive: true, run: forgetConnect }) }] : undefined)}
      environment={{ ...webClientEnvironment(profile), servedByHost: !connectSession, ...(connectSession ? { shell: { hostLabel: connectSession.name ?? "Tau Connect", actions: [{ id: "forget-connect", label: "Forget Tau Connect", run: () => { void forgetConnect(); } }] } } : {}) }}
    />
  </StrictMode>);
}

async function pairConnect(link: string): Promise<void> {
  currentPairing?.abort(); currentConnection?.close(); const ownAttempt = ++attempt;
  const cancel = new AbortController(); currentPairing = cancel;
  const wait = (verification?: string) => root.render(<StrictMode><PairingWait {...(verification ? { verification } : {})} onCancel={() => { cancel.abort(); if (ownAttempt === attempt) { attempt++; showGate(); } }} /></StrictMode>);
  wait();
  try {
    const [{ browserConnectOffer }, { BrowserConnectSocket }, { BrowserConnectStorage }] = await Promise.all([import("./connect/offer"), import("./connect/socket"), import("./connect/storage")]);
    if (ownAttempt !== attempt) return;
    if (cancel.signal.aborted) { showGate(); return; }
    const offer = browserConnectOffer(link);
    if (!offer) { showGate("This Tau Connect link is invalid or has no host key. Copy a new link from the host."); return; }
    let failure: string | undefined;
    const result = await pairWithHost({ url: offer.route.url, code: offer.code, name: "Browser", ...(offer.route.key ? { publicKey: offer.route.pin } : { fingerprint: offer.route.pin }), createSocket: () => new BrowserConnectSocket(offer.route, (message) => { failure = message; }), signal: cancel.signal, onWaiting: ({ verification }) => wait(verification) });
    if (ownAttempt !== attempt) return;
    if (result.state !== "approved") { showGate(cancel.signal.aborted ? undefined : failure ?? pairingNotice(result)); return; }
    const session = { route: offer.route, token: result.token, ...(offer.name ? { name: offer.name } : {}) };
    const saved = await new BrowserConnectStorage().save(session, () => ownAttempt === attempt && !cancel.signal.aborted);
    if (!saved) { if (ownAttempt === attempt) showGate(); return; }
    storage.remove(WEB_TOKEN_KEY);
    if (ownAttempt === attempt) connectSaved(session);
  } catch (error) { if (ownAttempt === attempt) showGate(error instanceof Error ? error.message : String(error)); }
}

function connectSaved(session: BrowserConnectSession): void {
  connectSession = session;
  const ownAttempt = attempt;
  void import("./connect/socket").then(({ BrowserConnectSocket }) => {
    if (ownAttempt !== attempt || connectSession !== session) return;
    connect(session.token, () => new BrowserConnectSocket(session.route, (message) => { if (ownAttempt !== attempt) return; currentConnection?.close(); showGate(message); }));
  }).catch((error: unknown) => { if (ownAttempt === attempt) showGate(String(error)); });
}

async function forgetConnect(): Promise<void> {
  currentPairing?.abort(); currentConnection?.close(); attempt++;
  try { const { BrowserConnectStorage } = await import("./connect/storage"); await new BrowserConnectStorage().remove(); connectSession = undefined; showGate(); }
  catch (error) { showGate(error instanceof Error ? error.message : String(error)); }
}

// The pairing code is taken out of the address bar before anything renders.
const code = takePairingCode(window);
const stored = storage.get(WEB_TOKEN_KEY);
if (code) pair(code);
else if (stored) connect(stored);
else {
  showGate();
  if (globalThis.isSecureContext && globalThis.indexedDB) void import("./connect/storage").then(async ({ BrowserConnectStorage }) => {
    const session = await new BrowserConnectStorage().load(); if (session && attempt === 0) connectSaved(session);
  }).catch((error: unknown) => { if (attempt === 0) showGate(error instanceof Error ? error.message : String(error)); });
}
