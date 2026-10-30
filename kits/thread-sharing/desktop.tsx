import { useEffect, useState, useSyncExternalStore } from "react";
import { Share2 } from "lucide-react";
import { Badge, Button, Dialog, Menu, Select, SettingRow, SettingsSection, SettingsState, Switch, READ_ONLY_REASON, errorMessage, useHostCapabilities, type DesktopExtension, type HostExtensionClient, type RegionProps, type SettingsSectionProps } from "tau";
import { ADDRESS_REASON, LIFETIMES, SHARING_EVENT, SHARING_ID, type SharingState, type SharedThread } from "./protocol.js";

const OWNER_REASON = "Create guest links in this machine's own Tau window.";
class SharingStore {
  state?: SharingState;
  error?: string;
  loading = false;
  target?: string;
  urls = new Map<string, string>();
  private version = 0;
  private listeners = new Set<() => void>();
  private active = true;
  constructor(readonly host: HostExtensionClient) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  snapshot = () => this.version;
  changed = () => { if (this.active) { this.version++; for (const fn of this.listeners) fn(); } };
  async refresh() {
    if (this.loading || !this.active) return;
    this.loading = true;
    try {
      const state = await this.host.invoke("state") as SharingState;
      if (!this.active) return;
      this.state = state; this.error = undefined;
      for (const id of this.urls.keys()) if (!state.links.some((link) => link.id === id)) this.urls.delete(id);
    } catch (error) { if (this.active) this.error = errorMessage(error); }
    finally { this.loading = false; this.changed(); }
  }
  async invoke(command: string, input: unknown) {
    const result = await this.host.invoke(command, input);
    await this.refresh();
    return result;
  }
  dispose() { this.active = false; this.urls.clear(); this.listeners.clear(); }
}
function Qr({ value }: { value: string }) {
  const [code, setCode] = useState<{ size: number; path: string }>();
  useEffect(() => {
    let active = true;
    void import("uqr").then(({ encode }) => {
      const { data, size } = encode(value, { ecc: "L", boostEcc: true, border: 2 });
      let path = "";
      data.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x} ${y}h1v1h-1z`; }));
      if (active) setCode({ size, path });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [value]);
  return code ? <svg width="208" height="208" viewBox={`0 0 ${code.size} ${code.size}`} className="guest-link-qr" shapeRendering="crispEdges" role="img" aria-label="Guest link as a QR code"><rect width={code.size} height={code.size} fill="white" /><path d={code.path} fill="black" /></svg> : null;
}
function useSharing(store: SharingStore) { useSyncExternalStore(store.subscribe, store.snapshot); return store.state; }
function SharingDialog({ store, actions }: { store: SharingStore; actions: RegionProps["actions"] }) {
  const state = useSharing(store);
  const [hours, setHours] = useState("8");
  const [mode, setMode] = useState("suggest");
  const [showToolOutput, setShowToolOutput] = useState(false);
  const [created, setCreated] = useState<{ id: string; url: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const threadId = store.target;
  const close = () => { store.target = undefined; store.changed(); };
  if (!threadId) return null;
  const toolOutputAvailable = state?.toolOutputThreads?.includes(threadId) === true;
  const reason = !state?.owner ? OWNER_REASON : !state.available ? ADDRESS_REASON : !state.enabled ? "Turn on Allow guest links under Settings → Connections." : undefined;
  return <Dialog label="Share with a guest" className="guest-link-dialog" onClose={close}>
    <header><h2>Share with a guest</h2></header>
    {created ? <>
      <p>Works in one browser. Opening it claims it.</p>
      <div className="connection-link-box"><code>{created.url}</code><Button onClick={() => { void actions.copyText(created.url).then(() => actions.notify("Guest link copied.")).catch((e) => setError(errorMessage(e))); }}>Copy link</Button></div>
      <Qr value={created.url} />
      <Button variant="danger" onClick={() => { void store.invoke("revoke", { id: created.id }).then(() => { actions.notify("Guest link stopped."); close(); }).catch((e) => setError(errorMessage(e))); }}>Stop sharing</Button>
    </> : <>
      <p>The guest sees this thread's messages and the agent's replies as they stream, and anything the agent read or printed in them. Share only what you'd show.</p>
      {state?.links.some((link) => link.threadId === threadId) ? <p>This replaces the current guest link.</p> : null}
      <SettingRow title="Expires after" control={<Select label="Expires after" value={hours} options={LIFETIMES.map((duration) => ({ value: String(duration), label: `${duration} hour${duration === 1 ? "" : "s"}` }))} onChange={setHours} />} />
      <SettingRow title="Guest can" control={<Select label="Guest can" value={mode} options={[{ value: "watch", label: "Watch" }, { value: "suggest", label: "Watch and suggest messages" }]} onChange={setMode} />} />
      <SettingRow title="Show tool output" description={toolOutputAvailable ? "Visible text output from supported tools only." : "Tool output sharing is unavailable in this version."} control={<Switch label="Show tool output" role="checkbox" checked={showToolOutput && toolOutputAvailable} disabled={!!reason || !toolOutputAvailable || busy} onChange={setShowToolOutput} />} />
      {reason ? <p role="status">{reason}</p> : null}
    </>}
    {error ? <SettingsState kind="error" title={error} onRetry={() => { setError(undefined); void store.refresh(); }} /> : null}
    <footer><Button onClick={close}>{created ? "Done" : "Cancel"}</Button>{!created ? <Button busy={busy} disabled={!!reason} onClick={() => {
      setBusy(true); setError(undefined);
      void store.invoke("create", { threadId, hours: Number(hours), mode, showToolOutput: showToolOutput && toolOutputAvailable }).then((value) => {
        const result = value as { id: string; url: string };
        store.urls.set(result.id, result.url); setCreated(result);
      }).catch((e) => setError(errorMessage(e))).finally(() => setBusy(false));
    }}>{busy ? "Creating…" : "Create link"}</Button> : null}</footer>
  </Dialog>;
}
function createSettings(store: SharingStore) {
  return function GuestSettings({ onNotify }: SettingsSectionProps) {
    const state = useSharing(store);
    const [busy, setBusy] = useState(false);
    const [delayed, setDelayed] = useState(false);
    useEffect(() => { const timer = setTimeout(() => setDelayed(true), 300); return () => clearTimeout(timer); }, []);
    const invoke = (command: string, input: unknown) => {
      setBusy(true);
      void store.invoke(command, input).catch((e) => onNotify(errorMessage(e), "error")).finally(() => setBusy(false));
    };
    return <SettingsSection title="Guest links (beta)">
      {!state ? store.error ? <SettingsState kind="error" title={store.error} onRetry={() => { void store.refresh(); }} /> : delayed ? <SettingsState kind="loading" title="Loading…" /> : null : <>
        <SettingRow id="setting-guest-links" title="Allow guest links" description="A guest follows one thread in a browser and can suggest messages. Nothing they send runs until you send it." disabledReason={state.owner ? undefined : OWNER_REASON} control={<Switch label="Allow guest links" checked={state.enabled} disabled={busy || !state.owner} onChange={(enabled) => invoke("enable", { enabled })} />} />
        {!state.available ? <p className="guest-links-note">{ADDRESS_REASON}</p> : null}
        {state.links.length ? <table className="guest-links-table"><thead><tr><th>Thread</th><th>Guest</th><th>Expires</th><th>Stop</th></tr></thead><tbody>{state.links.map((link) => <tr key={link.id}><td>{link.title}</td><td>{link.watching ? "Watching" : link.claimed ? "Claimed" : "Waiting"}</td><td>{new Date(link.expiresAt).toLocaleString()}</td><td><Button disabled={busy || !state.owner} onClick={() => { invoke("revoke", { id: link.id }); }}>Stop sharing</Button></td></tr>)}</tbody></table> : <SettingsState kind="empty" title="No thread is shared." />}
      </>}
    </SettingsSection>;
  };
}
function createHeader(store: SharingStore) {
  return function GuestHeader({ snapshot, actions }: RegionProps) {
    const state = useSharing(store);
    const [open, setOpen] = useState(false);
    const link = state?.links.find((item) => item.threadId === snapshot?.sessionId);
    const run = (id: string) => {
      setOpen(false);
      const url = link && store.urls.get(link.id);
      if (id === "copy" && url) void actions.copyText(url).then(() => actions.notify("Guest link copied.")).catch((e) => actions.notify(errorMessage(e), "error"));
      if (id === "stop" && link) void store.invoke("revoke", { id: link.id }).then(() => actions.notify("Guest link stopped.")).catch((e) => actions.notify(errorMessage(e), "error"));
    };
    return <>
      {link && state?.enabled ? <span className="menu-anchor"><button type="button" className="runtime-chip" onClick={() => setOpen(true)}><Badge>{link.watching ? "Shared · guest watching" : "Shared"}</Badge></button>{open ? <Menu sections={[{ heading: `Expires ${new Date(link.expiresAt).toLocaleTimeString()}`, items: [{ id: "copy", label: "Copy link", disabled: !store.urls.has(link.id), description: store.urls.has(link.id) ? undefined : "The link is shown only when created." }, { id: "stop", label: "Stop sharing", disabled: !state.owner, description: state.owner ? undefined : OWNER_REASON, destructive: true }] }]} onSelect={run} onClose={() => setOpen(false)} /> : null}</span> : null}
      {store.target ? <SharingDialog key={store.target} store={store} actions={actions} /> : null}
    </>;
  };
}
function GuestSuggestions({ store, link, actions }: { store: SharingStore; link: SharedThread; actions: RegionProps["actions"] }) {
  const { readOnly } = useHostCapabilities();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = link.suggestions.filter((suggestion) => suggestion.state === "pending" || suggestion.state === "sending");
  if (!pending.length) return null;
  return <section className="queue-shelf guest-suggestions" aria-label="Guest suggests" tabIndex={0} onMouseEnter={() => setArmed(true)} onFocus={() => setArmed(true)}>
    <header><b>Guest suggests</b></header>
    {pending.map((suggestion) => <div key={suggestion.id}><p className="queue-shelf-text">{suggestion.text}</p><div className="guest-suggestion-images">{suggestion.images.map((image, index) => <img key={index} src={`data:${image.mimeType};base64,${image.data}`} alt={`Guest attachment ${index + 1}`} />)}</div><footer>
      {(["send", "dismiss"] as const).map((action) => <Button key={action} disabled={readOnly || busy || suggestion.state === "sending" || (action === "send" && !armed)} title={readOnly ? READ_ONLY_REASON : undefined} onClick={() => {
        setBusy(true);
        void store.invoke(action, { id: link.id, suggestionId: suggestion.id }).catch((e) => actions.notify(errorMessage(e), "error")).finally(() => setBusy(false));
      }}>{action === "send" ? "Send" : "Dismiss"}</Button>)}
    </footer></div>)}
  </section>;
}
const sharing: DesktopExtension = {
  id: SHARING_ID, name: "Thread sharing",
  activate(context) {
    const store = new SharingStore(context.host);
    const releases = [
      context.host.onEvent(SHARING_EVENT, () => { void store.refresh(); }),
      context.registerSettingsSection({ id: "thread-sharing.connections", page: "connections", order: 30, profiles: ["desktop", "web", "compact"], rows: [{ id: "setting-guest-links", label: "Allow guest links", keywords: ["share", "guest", "expiry", "revoke"] }], Component: createSettings(store) }),
      context.registerCommand({ id: "thread-sharing.share", label: "Share with a guest…", group: "Thread", access: "write", Icon: Share2, surfaces: ["thread-title", "thread-row"], unavailable: () => !store.state?.owner ? OWNER_REASON : undefined, run: (actions, target) => { store.target = target?.threadId ?? actions.activeThread()?.sessionId; store.changed(); } }),
      context.registerRegion({ id: "thread-sharing.header", placement: "thread-title", order: 80, profiles: ["desktop", "web", "compact"], Component: createHeader(store) }),
      context.registerRegion({ id: "thread-sharing.suggestions", placement: "composer-above", order: 95, profiles: ["desktop", "web", "compact"], Component: ({ snapshot, actions }) => { const state = useSharing(store); const link = state?.enabled && state.links.find((item) => item.threadId === snapshot?.sessionId); return link ? <GuestSuggestions key={link.id} store={store} link={link} actions={actions} /> : null; } }),
      context.registerThreadListAccessory({ id: "thread-sharing.mark", Component: ({ session }) => { const state = useSharing(store); return state?.enabled && state.links.some((link) => link.threadId === session.id && link.suggestions.some((s) => s.state === "pending")) ? <Badge>Suggestion</Badge> : null; } }),
    ];
    void store.refresh();
    const poll = setInterval(() => { void store.refresh(); }, 3000);
    return () => { clearInterval(poll); for (const release of releases) release(); store.dispose(); };
  },
};
export default sharing;
