import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Box, ChevronRight, Home, Maximize2, Power, RefreshCw, Settings2, Smartphone, X } from "lucide-react";
import { Badge, Button, HelpTip, NumberField, SegmentedControl, Select, SettingRow, SettingsSection, Switch, TextField, useHostAvailability, type DesktopExtension, type PanelProps } from "tau";
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
  // Completing a capture must not restart the effect and take a second paused frame.
  const captureReadyRef = useRef(captureReady);
  captureReadyRef.current = captureReady;
  const [captureEpoch, setCaptureEpoch] = useState(0);
  const [fold, setFold] = useState<FoldState>();
  const [foldError, setFoldError] = useState("");
  const captureRevision = useRef(0);
  const actionPending = useRef(false);
  const [pose, setPose] = useState(false);
  const [live, setLive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [appId, setAppId] = useState("");
  const [latitude, setLatitude] = useState("0");
  const [longitude, setLongitude] = useState("0");
  const [permission, setPermission] = useState("camera");
  const pointer = useRef<{ x: number; y: number; width: number; height: number; pointerId: number; target: string; revision: number; surface: HTMLImageElement | HTMLCanvasElement } | undefined>(undefined);
  const device = devices.find((entry) => selected && entry.id === selected.deviceId && entry.hostId === selected.hostId);
  useEffect(() => { let cancelled = false; invoke<HubState>("state").then((value) => { if (!cancelled) { setState(value); setDevices(value.devices); } }).catch((reason) => { if (!cancelled) setError(message(reason)); }); return () => { cancelled = true; }; }, [invoke]);
  const refresh = async () => {
    setBusy(true); setError("");
    try { const list = await invoke<Device[]>("discover", { hostId }); setDevices((previous) => [...previous.filter((entry) => entry.hostId !== hostId), ...list]); }
    catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  };
  const perform = async (action: ActionInput["action"], rest: Partial<ActionInput> = {}) => {
    if (!selected || busy || actionPending.current || !availability.available) return;
    actionPending.current = true;
    captureRevision.current++;
    pointer.current = undefined;
    setBusy(true); setError("");
    try {
      if (action === "fold" || action === "rotate") setCaptureReady(false);
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
    } catch (reason) { setError(message(reason)); } finally { actionPending.current = false; captureRevision.current++; setCaptureEpoch((value) => value + 1); setBusy(false); }
  };
  useEffect(() => { captureRevision.current++; pointer.current = undefined; setFrame(undefined); setFold(undefined); setFoldError(""); setCaptureReady(true); setVideoFallback(""); }, [selected, device?.booted]);
  useEffect(() => { pointer.current = undefined; }, [active, availability.available]);
  useEffect(() => {
    if (!active || !availability.available || !selected || !device?.booted) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const capture = async () => {
      if (actionPending.current) return;
      if (document.hidden) { if (!cancelled && live) timer = setTimeout(() => { void capture(); }, 650); return; }
      const revision = captureRevision.current;
      try {
        let status: FoldState | undefined;
        if (device.platform === "android") {
          try { status = await invoke<FoldState>("fold-state", selected); if (!cancelled && revision === captureRevision.current) setFoldError(""); }
          catch (reason) { if (!cancelled && revision === captureRevision.current) setFoldError(message(reason)); }
        }
        if (cancelled || revision !== captureRevision.current || actionPending.current) return;
        if (!videoSource || !captureReadyRef.current || !live) {
          const next = await invoke<{ dataUrl: string }>("frame", selected);
          if (!cancelled && revision === captureRevision.current && !actionPending.current) { setFrame(next.dataUrl); setCaptureReady(true); if (status) setFold(status); }
        } else if (!cancelled && status && !actionPending.current) setFold(status);
      }
      catch (reason) { if (!cancelled && revision === captureRevision.current) setError(message(reason)); }
      if (!cancelled && live) timer = setTimeout(() => { void capture(); }, 650);
    };
    void capture();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, availability.available, selected, device?.booted, live, invoke, captureEpoch, videoSource]);
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
    if (width <= 0 || height <= 0 || bounds.width <= 0 || bounds.height <= 0) return;
    return { x: Math.round((event.clientX - bounds.left) * width / bounds.width), y: Math.round((event.clientY - bounds.top) * height / bounds.height), width, height };
  };
  const touchStart = (event: React.PointerEvent<HTMLImageElement | HTMLCanvasElement>) => {
    if (busy || actionPending.current || !captureReady || !active || !availability.available || !selected || !device?.booted) return;
    const start = point(event); if (!start) return;
    pointer.current = { ...start, pointerId: event.pointerId, target: key(selected), revision: captureRevision.current, surface: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const touchEnd = (event: React.PointerEvent<HTMLImageElement | HTMLCanvasElement>) => {
    const start = pointer.current;
    if (!start || start.pointerId !== event.pointerId) return;
    pointer.current = undefined;
    if (busy || actionPending.current || !captureReady || !active || !availability.available || !selected || !device?.booted || start.target !== key(selected) || start.revision !== captureRevision.current || start.surface !== event.currentTarget) return;
    const end = point(event); if (!end || start.width !== end.width || start.height !== end.height) return;
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const coordinates = { x: start.x, y: start.y };
    void perform(distance < 12 ? "tap" : "swipe", distance < 12 ? coordinates : { ...coordinates, endX: end.x, endY: end.y });
  };
  const disabled = busy || !availability.available;
  const hostDevices = devices.filter((entry) => entry.hostId === hostId);
  return <div className="devices-panel">
    <div className="devices-header">
      <Select label="Device host" value={hostId} options={(state?.settings.hosts ?? DEFAULT_SETTINGS.hosts).map((host) => ({ value: host.id, label: host.name }))} onChange={setHostId} />
      {device && <Select label="Open a device" value={undefined} placeholder="Add device…" options={hostDevices.map((entry) => ({ value: entry.id, label: entry.name }))} onChange={(id) => { const next = hostDevices.find((entry) => entry.id === id); if (next) open(next); }} />}
      <div className="devices-header-actions">
        <Button variant="ghost" icon={<RefreshCw size={14} />} aria-label="Refresh devices" title="Refresh devices" busy={busy} disabled={!availability.available} onClick={() => { void refresh(); }} />
        <Button variant="ghost" icon={<Settings2 size={14} />} aria-label="Device settings" title="Device settings" onClick={() => actions.openSettings("devices.settings")} />
      </div>
    </div>
    {!availability.available && <p className="devices-notice" role="status">{availability.reason}</p>}
    {error && <p role="alert" className="devices-error">{error}</p>}
    {!device && <div className="devices-discovery">
      <div className="devices-section-label">Available devices <span>{hostDevices.length}</span></div>
      {hostDevices.map((entry) => <button className="devices-device-row" key={entry.id} aria-label={`${entry.name} · ${entry.platform} ${entry.version} · ${entry.booted ? "Running" : "Off"}`} onClick={() => open(entry)}>
        <Smartphone size={18} aria-hidden /><span className="devices-device-name"><strong>{entry.name}</strong><small>{entry.platform === "ios" ? "iOS" : "Android"} {entry.version}</small></span><Badge dot tone={entry.booted ? "success" : "neutral"}>{entry.booted ? "Running" : "Off"}</Badge><ChevronRight size={14} aria-hidden />
      </button>)}
      {!hostDevices.length && <div className="devices-empty"><Smartphone size={28} strokeWidth={1.3} aria-hidden /><strong>No devices found</strong><p>Refresh to find simulators and emulators on this host. Set up the device tools in Settings first.</p><Button icon={<Settings2 size={14} />} onClick={() => actions.openSettings("devices.settings")}>Device settings</Button></div>}
    </div>}
    {tabs.length > 0 && <div className="devices-tabs" role="tablist" aria-label="Open devices">{tabs.map((target) => {
      const current = devices.find((entry) => entry.id === target.deviceId && entry.hostId === target.hostId);
      return <span key={key(target)} data-selected={selected && key(selected) === key(target) ? "" : undefined}><button role="tab" aria-selected={Boolean(selected && key(selected) === key(target))} onClick={() => setSelected(target)}><Smartphone size={13} aria-hidden />{current?.name ?? target.deviceId}</button><button className="devices-tab-close" aria-label={`Close ${current?.name ?? target.deviceId}`} onClick={() => { setTabs((previous) => previous.filter((entry) => key(entry) !== key(target))); if (selected && key(selected) === key(target)) setSelected(tabs.find((entry) => key(entry) !== key(target))); }}><X size={12} /></button></span>;
    })}</div>}
    {device && <>
      <div className="devices-view-toolbar">
        <SegmentedControl label="Device view" value={pose ? "3d" : "flat"} options={[{ value: "flat", label: "Flat screen", icon: <Smartphone size={13} />, labelled: true }, { value: "3d", label: "3D view", icon: <Box size={13} />, labelled: true }]} disabled={!frame && !videoSource} onChange={(value) => setPose(value === "3d")} />
        <span className="devices-stream-status" title={videoFallback || undefined}>{!device.booted ? "Device off" : !live ? "Paused" : videoSource ? "Live video" : frame ? "Screen captures" : "Connecting…"}</span>
        <label className="devices-live"><span>Live screen</span><Switch role="checkbox" label="Live screen" checked={live} onChange={setLive} /></label>
        {floating && <Button variant="ghost" icon={<Maximize2 size={14} />} aria-label="Float over chat" title="Float over chat" disabled={!device.booted} onClick={() => { floating.set({ ...targetOf(device), name: device.name }); setLive(false); }} />}
        <Button variant="ghost" icon={<Power size={14} />} aria-label={device.booted ? "Shut down" : "Boot"} title={device.booted ? "Shut down" : "Boot"} disabled={disabled} onClick={() => { void perform(device.booted ? "shutdown" : "boot"); }} />
      </div>
      {device.booted && device.platform === "android" && fold?.supported && <div className="devices-posture">
        <span>Device posture: {({ opened: "Opened", closed: "Closed", half_opened: "Half open", flipped: "Flipped", tent: "Tent" } as Record<string, string>)[fold.posture ?? ""] ?? "Unknown"}{fold.hingeAngle !== null ? ` · ${Math.round(fold.hingeAngle)}°` : ""}</span>
        <div className="devices-field-actions"><Button aria-label="Fold device" disabled={disabled || fold.posture === "closed"} onClick={() => { void perform("fold", { enabled: true }); }}>Fold</Button><Button aria-label="Unfold device" disabled={disabled || fold.posture === "opened"} onClick={() => { void perform("fold", { enabled: false }); }}>Unfold</Button></div>
      </div>}
      {foldError && <p className="devices-notice" role="status">Cannot read device posture. <HelpTip text={foldError} /></p>}
      <div className="devices-view">
        {active && availability.available && selected && device.booted && live && captureReady && !videoFallback && <div style={{ display: pose || !videoSource ? "none" : "contents" }}><Suspense fallback={null}><VideoDeviceScreen target={selected} invoke={invoke} name={device.name} onCanvas={receiveCanvas} onFallback={fallbackVideo} onPointerDown={touchStart} onPointerUp={touchEnd} onPointerCancel={() => { pointer.current = undefined; }} /></Suspense></div>}
        {(frame || videoSource) && pose ? <Suspense fallback={<p>Loading 3D view…</p>}><DevicePoseView key={key(targetOf(device))} image={frame ?? ""} source={videoSource?.canvas} device={device} fold={fold} captureReady={captureReady} onInteract={() => setPose(false)} /></Suspense> : frame && !videoSource ? <img src={frame} alt={`${device.name} screen`} draggable={false} onPointerDown={touchStart} onPointerUp={touchEnd} onPointerCancel={() => { pointer.current = undefined; }} /> : !videoSource ? <p>{device.booted ? "Waiting for the screen…" : "Device is off"}</p> : null}
      </div>
      {device.booted && <div className="devices-controls">
        <div className="devices-input-bar">
          <Button variant="ghost" icon={<Home size={14} />} disabled={disabled} aria-label="Home" title="Home" onClick={() => { void perform("home"); }} />
          {device.platform === "android" && <Button variant="ghost" icon={<ArrowLeft size={14} />} disabled={disabled} aria-label="Back" title="Back" onClick={() => { void perform("back"); }} />}
          <Select label="Orientation" value={undefined} placeholder="Orientation" disabled={disabled} options={[{ value: "portrait", label: "Portrait" }, { value: "landscape-left", label: "Landscape left" }, { value: "landscape-right", label: "Landscape right" }, { value: "portrait-upside-down", label: "Upside down" }]} onChange={(value) => { void perform("rotate", { value }); }} />
          <TextField label="Device text" value={text} onChange={setText} width="full" placeholder="Type into focused field" />
          <Button disabled={disabled || !text} onClick={() => { void perform("text", { value: text }); }}>Send text</Button>
        </div>
        <details className="devices-advanced"><summary><Settings2 size={14} />Device controls<ChevronRight size={14} /></summary><div className="devices-control-sections">
          <SettingsSection title="Apps and display">
            <SettingRow title="Open app" control={<div className="devices-field-actions"><TextField label="App identifier" mono placeholder="com.example.app" value={appId} onChange={setAppId} /><Button disabled={disabled || !appId} onClick={() => { void perform("open", { appId }); }}>Open app</Button></div>} />
            <SettingRow title="Appearance" control={<Select label="Appearance" value={undefined} placeholder="Choose appearance" disabled={disabled} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} onChange={(value) => { void perform("appearance", { value }); }} />} />
            <SettingRow title="Text size" control={<Select label="Text size" value={undefined} disabled={disabled} options={["small", "default", "large", "extra-large"].map((value) => ({ value, label: value === "extra-large" ? "Extra large" : value[0]!.toUpperCase() + value.slice(1) }))} onChange={(value) => { void perform("textSize", { value }); }} />} />
          </SettingsSection>
          <SettingsSection title="Location and permissions">
            <SettingRow title="Location" control={<div className="devices-field-actions"><NumberField label="Latitude" min={-90} max={90} step={.0001} value={Number(latitude)} disabled={disabled} onCommit={(value) => setLatitude(String(value))} /><NumberField label="Longitude" min={-180} max={180} step={.0001} value={Number(longitude)} disabled={disabled} onCommit={(value) => setLongitude(String(value))} /><Button disabled={disabled} onClick={() => { void perform("location", { latitude: Number(latitude), longitude: Number(longitude) }); }}>Set location</Button>{device.platform === "ios" && <Button variant="ghost" disabled={disabled} onClick={() => { void perform("clearLocation"); }}>Clear location</Button>}</div>} />
            <SettingRow title="App permission" description="Uses the app identifier above." control={<div className="devices-field-actions"><Select label="App permission" value={permission} options={["camera", "microphone", "location", "contacts", "calendar"].map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) }))} onChange={setPermission} /><Button disabled={disabled || !appId} onClick={() => { void perform("permission", { appId, permission, value: "grant" }); }}>Grant permission</Button><Button disabled={disabled || !appId} onClick={() => { void perform("permission", { appId, permission, value: "revoke" }); }}>Revoke permission</Button></div>} />
          </SettingsSection>
          <SettingsSection title="Accessibility">
            {(device.platform === "ios" ? ["reduceMotion", "increaseContrast", "reduceTransparency", "voiceOver"] : ["reduceMotion"]).map((setting) => <SettingRow key={setting} title={({ reduceMotion: "Reduce motion", increaseContrast: "Increase contrast", reduceTransparency: "Reduce transparency", voiceOver: "VoiceOver" } as Record<string, string>)[setting]} control={<div className="devices-field-actions"><Button disabled={disabled} onClick={() => { void perform("accessibility", { value: setting, enabled: true }); }}>On</Button><Button disabled={disabled} onClick={() => { void perform("accessibility", { value: setting, enabled: false }); }}>Off</Button></div>} />)}
          </SettingsSection>
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
  const disabled = busy || !availability.available;
  return <div className="settings-page devices-settings">
    {!availability.available && <p role="status">{availability.reason}</p>}
    {error && <p role="alert" className="devices-error">{error}</p>}{status && <p className="devices-notice" role="status">{status}</p>}
    <SettingsSection title="Agent access">
      <SettingRow title="Allow agents to control devices" description="Screenshots and device input for agents. Off by default. Save to apply." help="Includes device power, location, accessibility and app permissions." control={<Switch label="Allow agents to control devices" role="checkbox" checked={settings.agentControl} disabled={disabled} onChange={(agentControl) => setSettings({ ...settings, agentControl })} />} />
    </SettingsSection>
    <SettingsSection title="Device hosts" headerAction={<Button variant="ghost" icon={<Smartphone size={14} />} disabled={disabled} onClick={() => setSettings({ ...settings, hosts: [...settings.hosts, { id: `ssh-${Date.now()}`, name: "Remote devices", ssh: "", remoteDirectory: "" }] })}>Add SSH host</Button>}>
      {settings.hosts.map((host, index) => {
        const change = (field: "name" | "ssh" | "remoteDirectory", value: string) => setSettings({ ...settings, hosts: settings.hosts.map((entry) => entry.id === host.id ? { ...entry, [field]: value } : entry) });
        const saved = state?.settings.hosts.some((entry) => JSON.stringify(entry) === JSON.stringify(host));
        return <div key={host.id} className="devices-host">
          <SettingRow title={host.id === "local" ? "This computer" : "SSH host"} control={<div className="devices-field-actions"><TextField label={`Host ${index + 1} name`} value={host.name} disabled={disabled} onChange={(value) => change("name", value)} />{host.id !== "local" && <Button variant="ghost" disabled={disabled} aria-label={`Remove ${host.name}`} onClick={() => setSettings({ ...settings, hosts: settings.hosts.filter((entry) => entry.id !== host.id) })}>Remove</Button>}</div>} />
          {host.id !== "local" && <><SettingRow title="SSH alias" description="A host from your SSH configuration." control={<TextField label={`Host ${index + 1} SSH alias`} mono placeholder="SSH config alias" value={host.ssh ?? ""} disabled={disabled} onChange={(value) => change("ssh", value)} />} /><SettingRow title="Tool directory" description="An absolute path on the remote host." control={<TextField label={`Host ${index + 1} tool directory`} mono placeholder="/path/to/tau-device-tools" value={host.remoteDirectory ?? ""} disabled={disabled} onChange={(value) => change("remoteDirectory", value)} />} /></>}
          <SettingRow title="Device tools" description={host.id === "local" ? "Private tools for Tau. Requires Xcode or the Android SDK." : "Save this host before installing. Requires trusted, key-based SSH access."} control={<div className="devices-field-actions"><Button disabled={disabled || !saved} onClick={() => { void work("install", { hostId: host.id, tool: "hub" }); }}>Install viewer</Button><Button disabled={disabled || !saved} onClick={() => { void work("install", { hostId: host.id, tool: "agent" }); }}>Install input tools</Button></div>} />
        </div>;
      })}
    </SettingsSection>
    <SettingsSection title="Toolchain">
      <SettingRow title="Node executable" control={<TextField label="Node executable" mono value={settings.node} disabled={disabled} onChange={(node) => setSettings({ ...settings, node })} />} />
      <SettingRow title="npm executable" control={<TextField label="npm executable" mono value={settings.npm} disabled={disabled} onChange={(npm) => setSettings({ ...settings, npm })} />} />
      {state?.tools.map((tool) => <SettingRow key={tool.tool} title={tool.package} description={`Supported ${tool.required}${tool.latest ? ` · Latest ${tool.latest}` : ""}`} control={<Badge dot tone={tool.installed ? "success" : "neutral"}>{tool.installed ? "Installed locally" : "Not installed"}</Badge>} />)}
      <SettingRow title="Supported versions" description="Check for newer versions. Updates are installed separately." control={<Button disabled={disabled} onClick={() => { void work("check-versions"); }}>Check tool versions</Button>} />
    </SettingsSection>
    <div className="devices-settings-footer"><Button variant="primary" busy={busy} disabled={!availability.available} onClick={() => { void work("configure", settings); }}>Save device settings</Button></div>
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
