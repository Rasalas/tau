import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Smartphone } from "lucide-react";
import { useHostAvailability, type DesktopExtension, type PanelProps } from "tau";
import { DEFAULT_SETTINGS, DEVICE_KIT, type ActionInput, type Device, type DeviceSettings, type HubState, type FoldState, type Target } from "./protocol.js";

import { FloatingDevice, FloatingDeviceView } from "./floating.js";
const DevicePoseView = lazy(() => import("./pose-view.js"));
const VideoDeviceScreen = lazy(() => import("./video-screen.js"));

export type Invoke = <T>(command: string, input?: unknown) => Promise<T>;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const key = (device: Target) => `${device.hostId}/${device.deviceId}`;
const targetOf = (device: Device): Target => ({ hostId: device.hostId, deviceId: device.id });

export function DevicePanel({ active, actions, invoke, floating }: PanelProps & { invoke: Invoke; floating?: FloatingDevice }) {
  const availability = useHostAvailability(DEVICE_KIT);
  const [state, setState] = useState<HubState>();
  const [hostId, setHostId] = useState("local");
  const [devices, setDevices] = useState<Device[]>([]);
  const [tabs, setTabs] = useState<Target[]>([]);
  const [selected, setSelected] = useState<Target>();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [frame, setFrame] = useState<string>();
  const [videoSource, setVideoSource] = useState<{ canvas: HTMLCanvasElement }>();
  const [videoFallback, setVideoFallback] = useState("");
  const receiveCanvas = useCallback((canvas: HTMLCanvasElement | undefined) => setVideoSource(canvas ? { canvas } : undefined), []);
  const fallbackVideo = useCallback((reason: string) => setVideoFallback(reason), []);
  const [captureReady, setCaptureReady] = useState(true);
  const [captureEpoch, setCaptureEpoch] = useState(0);
  const [fold, setFold] = useState<FoldState>();
  const [foldError, setFoldError] = useState("");
  const captureRevision = useRef(0);
  const folding = useRef(false);
  const [pose, setPose] = useState(false);
  const [live, setLive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [appId, setAppId] = useState("");
  const [latitude, setLatitude] = useState("0");
  const [longitude, setLongitude] = useState("0");
  const [permission, setPermission] = useState("camera");
  const pointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const device = devices.find((entry) => selected && entry.id === selected.deviceId && entry.hostId === selected.hostId);
  useEffect(() => { let cancelled = false; invoke<HubState>("state").then((value) => { if (!cancelled) { setState(value); setDevices(value.devices); } }).catch((reason) => { if (!cancelled) setError(message(reason)); }); return () => { cancelled = true; }; }, [invoke]);
  const refresh = async () => {
    setBusy(true); setError("");
    try { const list = await invoke<Device[]>("discover", { hostId }); setDevices((previous) => [...previous.filter((entry) => entry.hostId !== hostId), ...list]); }
    catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  };
  const perform = async (action: ActionInput["action"], rest: Partial<ActionInput> = {}) => {
    if (!selected || busy) return;
    setBusy(true); setError("");
    try {
      if (action === "fold") { folding.current = true; captureRevision.current++; setCaptureReady(false); }
      const result = await invoke<{ id?: string; serial?: string } & Partial<FoldState>>("action", { ...selected, action, ...rest });
      if (action === "fold" && selectedRef.current && key(selectedRef.current) === key(selected) && typeof result.supported === "boolean") setFold(result as FoldState);
      if (action === "boot" || action === "shutdown") {
        const list = await invoke<Device[]>("discover", { hostId: selected.hostId });
        setDevices((previous) => [...previous.filter((entry) => entry.hostId !== selected.hostId), ...list]);
        const authoritative = result.serial ?? result.id;
        const replacement = list.find((entry) => entry.id === authoritative) ?? list.find((entry) => entry.name === device?.name);
        if (replacement && replacement.id !== selected.deviceId) {
          const next = targetOf(replacement);
          setTabs((previous) => previous.map((entry) => key(entry) === key(selected) ? next : entry));
          setSelected(next);
        }
      }
    } catch (reason) { setError(message(reason)); } finally { if (action === "fold") { folding.current = false; captureRevision.current++; setCaptureEpoch((value) => value + 1); } setBusy(false); }
  };
  useEffect(() => { setFrame(undefined); setFold(undefined); setFoldError(""); setCaptureReady(true); setVideoFallback(""); }, [selected, device?.booted]);
  useEffect(() => {
    if (!active || !availability.available || !selected || !device?.booted) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const capture = async () => {
      if (document.hidden) { if (!cancelled && live) timer = setTimeout(() => { void capture(); }, 650); return; }
      const revision = captureRevision.current;
      try {
        let status: FoldState | undefined;
        if (device.platform === "android") {
          try { status = await invoke<FoldState>("fold-state", selected); if (!cancelled) setFoldError(""); }
          catch (reason) { if (!cancelled) setFoldError(message(reason)); }
        }
        if (!videoSource || !captureReady || !live) {
          const next = await invoke<{ dataUrl: string }>("frame", selected);
          if (!cancelled && revision === captureRevision.current && !folding.current) { setFrame(next.dataUrl); setCaptureReady(true); if (status) setFold(status); }
        } else if (!cancelled && status && !folding.current) setFold(status);
      }
      catch (reason) { if (!cancelled) setError(message(reason)); }
      if (!cancelled && live) timer = setTimeout(() => { void capture(); }, 650);
    };
    void capture();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, availability.available, selected, device?.booted, live, invoke, captureEpoch, videoSource, captureReady]);
  const open = (next: Device) => {
    const target = targetOf(next);
    setTabs((previous) => previous.some((entry) => key(entry) === key(target)) ? previous : [...previous, target]);
    setSelected(target); setError("");
  };
  const point = (event: React.PointerEvent<HTMLImageElement | HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const surface = event.currentTarget;
    const width = surface instanceof HTMLImageElement ? surface.naturalWidth : surface.width;
    const height = surface instanceof HTMLImageElement ? surface.naturalHeight : surface.height;
    return { x: Math.round((event.clientX - bounds.left) * width / bounds.width), y: Math.round((event.clientY - bounds.top) * height / bounds.height) };
  };
  const touchStart = (event: React.PointerEvent<HTMLImageElement | HTMLCanvasElement>) => { if (busy || !captureReady) return; pointer.current = point(event); event.currentTarget.setPointerCapture(event.pointerId); };
  const touchEnd = (event: React.PointerEvent<HTMLImageElement | HTMLCanvasElement>) => {
    const start = pointer.current; pointer.current = undefined; if (!start) return;
    const end = point(event), distance = Math.hypot(end.x - start.x, end.y - start.y);
    void perform(distance < 12 ? "tap" : "swipe", distance < 12 ? start : { ...start, endX: end.x, endY: end.y });
  };
  return <div className="devices-panel">
    {!availability.available && <p role="status">{availability.reason}</p>}
    <div className="devices-toolbar">
      <label>Host <select aria-label="Device host" value={hostId} onChange={(event) => setHostId(event.target.value)}>{(state?.settings.hosts ?? DEFAULT_SETTINGS.hosts).map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}</select></label>
      <button disabled={busy || !availability.available} onClick={() => { void refresh(); }}>Refresh devices</button>
      <button onClick={() => actions.openSettings("devices.settings")}>Device settings</button>
      {busy && <small role="status">Working…</small>}
    </div>
    {error && <p role="alert" className="devices-error">{error}</p>}
    <div className="devices-toolbar">{devices.filter((entry) => entry.hostId === hostId).map((entry) => <button key={entry.id} onClick={() => open(entry)}>{entry.name} · {entry.platform} {entry.version} · {entry.booted ? "Running" : "Off"}</button>)}</div>
    {!devices.length && <p>Install the device tools in Device settings, then refresh. Xcode or the Android SDK must already be installed on the selected host.</p>}
    <div className="devices-tabs" role="tablist" aria-label="Open devices">{tabs.map((target) => {
      const current = devices.find((entry) => entry.id === target.deviceId && entry.hostId === target.hostId);
      return <span key={key(target)}><button role="tab" aria-selected={selected && key(selected) === key(target)} onClick={() => setSelected(target)}>{current?.name ?? target.deviceId}</button><button aria-label={`Close ${current?.name ?? target.deviceId}`} onClick={() => { setTabs((previous) => previous.filter((entry) => key(entry) !== key(target))); if (selected && key(selected) === key(target)) setSelected(tabs.find((entry) => key(entry) !== key(target))); }}>×</button></span>;
    })}</div>
    {device && <>
      <div className="devices-toolbar">
        <button disabled={busy || !availability.available} onClick={() => { void perform(device.booted ? "shutdown" : "boot"); }}>{device.booted ? "Shut down" : "Boot"}</button>
        <label><input type="checkbox" checked={live} onChange={(event) => setLive(event.target.checked)} />Live screen</label>
        <button disabled={!frame && !videoSource} onClick={() => setPose(!pose)}>{pose ? "Flat screen" : "3D view"}</button>
        {floating && <button disabled={!device.booted} onClick={() => { floating.set({ ...targetOf(device), name: device.name }); setLive(false); }}>Float over chat</button>}
        <small>{videoSource ? "Live video" : videoFallback || "Connecting device video…"}</small>
      </div>
      {foldError && <small role="status">Cannot read device posture: {foldError}</small>}
      <div className="devices-view">
        {active && availability.available && selected && device.booted && live && captureReady && !videoFallback && <div style={{ display: pose || !videoSource ? "none" : "contents" }}><Suspense fallback={null}><VideoDeviceScreen target={selected} invoke={invoke} name={device.name} onCanvas={receiveCanvas} onFallback={fallbackVideo} onPointerDown={touchStart} onPointerUp={touchEnd} onPointerCancel={() => { pointer.current = undefined; }} /></Suspense></div>}
        {(frame || videoSource) && pose ? <Suspense fallback={<p>Loading 3D view…</p>}><DevicePoseView key={key(targetOf(device))} image={frame ?? ""} source={videoSource?.canvas} device={device} fold={fold} captureReady={captureReady} /></Suspense> : frame && !videoSource ? <img src={frame} alt={`${device.name} screen`} draggable={false} onPointerDown={touchStart} onPointerUp={touchEnd} onPointerCancel={() => { pointer.current = undefined; }} /> : !videoSource ? <p>{device.booted ? "Waiting for the screen…" : "Device is off"}</p> : null}
      </div>
      {device.booted && <div className="devices-controls">
        <button disabled={busy || !availability.available} onClick={() => { void perform("home"); }}>Home</button>
        {device.platform === "android" && <button disabled={busy || !availability.available} onClick={() => { void perform("back"); }}>Back</button>}
        <select aria-label="Orientation" defaultValue="" disabled={busy || !availability.available} onChange={(event) => { if (event.target.value) void perform("rotate", { value: event.target.value }); }}><option value="" disabled>Orientation</option><option value="portrait">Portrait</option><option value="landscape-left">Landscape left</option><option value="landscape-right">Landscape right</option><option value="portrait-upside-down">Upside down</option></select>
        <input aria-label="Device text" value={text} onChange={(event) => setText(event.target.value)} placeholder="Type into focused field" /><button disabled={busy || !availability.available || !text} onClick={() => { void perform("text", { value: text }); }}>Send text</button>
        <details><summary>Device controls</summary><div>
          <label>App <input aria-label="App identifier" placeholder="com.example.app" value={appId} onChange={(event) => setAppId(event.target.value)} /></label><button disabled={busy || !availability.available || !appId} onClick={() => { void perform("open", { appId }); }}>Open app</button>
          <select aria-label="Appearance" defaultValue="" disabled={busy || !availability.available} onChange={(event) => { void perform("appearance", { value: event.target.value }); }}><option value="" disabled>Appearance</option><option value="light">Light</option><option value="dark">Dark</option></select>
          <select aria-label="Text size" defaultValue="" disabled={busy || !availability.available} onChange={(event) => { void perform("textSize", { value: event.target.value }); }}><option value="" disabled>Text size</option>{["small", "default", "large", "extra-large"].map((size) => <option key={size} value={size}>{size}</option>)}</select>
          <label>Latitude <input aria-label="Latitude" type="number" min="-90" max="90" value={latitude} onChange={(event) => setLatitude(event.target.value)} /></label><label>Longitude <input aria-label="Longitude" type="number" min="-180" max="180" value={longitude} onChange={(event) => setLongitude(event.target.value)} /></label><button disabled={busy || !availability.available} onClick={() => { void perform("location", { latitude: Number(latitude), longitude: Number(longitude) }); }}>Set location</button>
          {device.platform === "ios" && <button disabled={busy || !availability.available} onClick={() => { void perform("clearLocation"); }}>Clear location</button>}
          <select aria-label="App permission" value={permission} onChange={(event) => setPermission(event.target.value)}>{["camera", "microphone", "location", "contacts", "calendar"].map((name) => <option key={name}>{name}</option>)}</select>
          <button disabled={busy || !availability.available || !appId} onClick={() => { void perform("permission", { appId, permission, value: "grant" }); }}>Grant permission</button><button disabled={busy || !availability.available || !appId} onClick={() => { void perform("permission", { appId, permission, value: "revoke" }); }}>Revoke permission</button>
          {(device.platform === "ios" ? ["reduceMotion", "increaseContrast", "reduceTransparency", "voiceOver"] : ["reduceMotion"]).map((setting) => <span key={setting}>{setting} <button disabled={busy || !availability.available} onClick={() => { void perform("accessibility", { value: setting, enabled: true }); }}>On</button><button disabled={busy || !availability.available} onClick={() => { void perform("accessibility", { value: setting, enabled: false }); }}>Off</button></span>)}
          {device.platform === "android" && fold?.supported && <span>Device posture: {fold.posture ?? "Unknown"}{fold.hingeAngle !== null ? ` · ${Math.round(fold.hingeAngle)}°` : ""} <button disabled={busy || !availability.available} onClick={() => { void perform("fold", { enabled: true }); }}>Closed</button><button disabled={busy || !availability.available} onClick={() => { void perform("fold", { enabled: false }); }}>Opened</button></span>}
        </div></details>
      </div>}
    </>}
  </div>;
}
export function DeviceSettingsPage({ invoke }: { invoke: Invoke }) {
  const availability = useHostAvailability(DEVICE_KIT);
  const [state, setState] = useState<HubState>();
  const [settings, setSettings] = useState<DeviceSettings>(structuredClone(DEFAULT_SETTINGS));
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [status, setStatus] = useState("");
  useEffect(() => { let cancelled = false; invoke<HubState>("state").then((value) => { if (!cancelled) { setState(value); setSettings(value.settings); } }).catch((reason) => { if (!cancelled) setError(message(reason)); }); return () => { cancelled = true; }; }, [invoke]);
  const work = async (command: string, input?: unknown) => {
    setBusy(true); setError(""); setStatus("");
    try { const next = await invoke<HubState>(command, input); setState(next); setSettings(next.settings); setStatus(command === "configure" ? "Settings saved." : "Done."); } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  };
  return <div className="devices-settings">
    <h2>Devices</h2>
    {!availability.available && <p role="status">{availability.reason}</p>}
    <p>Tau uses expo-device-hub to discover and capture devices and agent-device for input. Tools install privately for Tau. Xcode and Android SDK installations stay under your control.</p>
    {error && <p role="alert" className="devices-error">{error}</p>}{status && <p role="status">{status}</p>}
    <label><input type="checkbox" checked={settings.agentControl} disabled={busy || !availability.available} onChange={(event) => setSettings({ ...settings, agentControl: event.target.checked })} />Allow agents to view and control simulators and emulators on these hosts</label>
    <small>Off by default. Enabling allows app input, boot and shutdown, accessibility changes, location changes, and app permission changes through Tau device tools. Save to apply.</small>
    <label>Node executable <input value={settings.node} onChange={(event) => setSettings({ ...settings, node: event.target.value })} /></label>
    <label>npm executable <input value={settings.npm} onChange={(event) => setSettings({ ...settings, npm: event.target.value })} /></label>
    {settings.hosts.map((host, index) => <div key={host.id} className="devices-host">
      <input aria-label={`Host ${index + 1} name`} value={host.name} onChange={(event) => setSettings({ ...settings, hosts: settings.hosts.map((entry) => entry.id === host.id ? { ...entry, name: event.target.value } : entry) })} />
      {host.id !== "local" && <><input aria-label={`Host ${index + 1} SSH alias`} placeholder="SSH config alias" value={host.ssh ?? ""} onChange={(event) => setSettings({ ...settings, hosts: settings.hosts.map((entry) => entry.id === host.id ? { ...entry, ssh: event.target.value } : entry) })} /><input aria-label={`Host ${index + 1} tool directory`} placeholder="/absolute/path/to/tau-device-tools" value={host.remoteDirectory ?? ""} onChange={(event) => setSettings({ ...settings, hosts: settings.hosts.map((entry) => entry.id === host.id ? { ...entry, remoteDirectory: event.target.value } : entry) })} /><button disabled={busy || !availability.available} onClick={() => setSettings({ ...settings, hosts: settings.hosts.filter((entry) => entry.id !== host.id) })}>Remove</button></>}
      <button disabled={busy || !availability.available || !state?.settings.hosts.some((entry) => JSON.stringify(entry) === JSON.stringify(host))} onClick={() => { void work("install", { hostId: host.id, tool: "hub" }); }}>Install viewer</button><button disabled={busy || !availability.available || !state?.settings.hosts.some((entry) => JSON.stringify(entry) === JSON.stringify(host))} onClick={() => { void work("install", { hostId: host.id, tool: "agent" }); }}>Install input tools</button>
    </div>)}
    <button disabled={busy || !availability.available} onClick={() => setSettings({ ...settings, hosts: [...settings.hosts, { id: `ssh-${Date.now()}`, name: "Remote devices", ssh: "", remoteDirectory: "" }] })}>Add SSH host</button>
    <small>SSH requires a trusted host key and key-based login already configured. Save the host before installing tools. The viewer binds remote loopback and reaches Tau through an SSH tunnel.</small>
    <div className="devices-toolbar"><button disabled={busy || !availability.available} onClick={() => { void work("configure", settings); }}>Save device settings</button><button disabled={busy || !availability.available} onClick={() => { void work("check-versions"); }}>Check tool versions</button>{busy && <span role="status">Working…</span>}</div>
    {state?.tools.map((tool) => <p key={tool.tool}>{tool.package} · supported {tool.required} · {tool.installed ? "Installed locally" : "Not installed locally"}{tool.latest ? ` · latest ${tool.latest}` : ""}</p>)}
    <small>Tau pins tested versions. Install repairs a missing supported version; checking a newer release never silently changes the driver contract.</small>
  </div>;
}
export default {
  id: DEVICE_KIT, name: "Devices",
  activate(context) {
    const floating = new FloatingDevice();
    const invoke: Invoke = <T,>(command: string, input?: unknown) => context.host.invoke(command, input) as Promise<T>;
    context.registerPanel({ id: "devices", label: "Devices", Icon: Smartphone, order: 45, width: "wide", maximizable: true, stageButton: true, profiles: ["desktop", "web", "compact"], Component: (props) => <DevicePanel {...props} invoke={invoke} floating={floating} /> });
    context.registerRegion({ id: "devices.floating", placement: "composer-above", order: 62, profiles: ["desktop", "web", "compact"], Component: (props) => <FloatingDeviceView {...props} store={floating} invoke={invoke} /> });
    context.registerSettingsPage({ id: "devices.settings", label: "Devices", description: "View and control simulators and emulators on this computer or an SSH host, and choose whether agents can use them.", Icon: Smartphone, order: 45, profiles: ["desktop", "web", "compact"], Component: () => <DeviceSettingsPage invoke={invoke} /> });
    context.registerCommand({ id: "devices.open", label: "Open devices", group: "Devices", access: "read", run: (actions) => actions.openPanel("devices") });
    return () => floating.set();
  },
} satisfies DesktopExtension;
