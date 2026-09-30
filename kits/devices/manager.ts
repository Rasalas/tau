import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SETTINGS, TOOLS, type ActionInput, type Device, type DeviceHost, type DeviceSettings, type HubState, type Target } from "./protocol.js";
import { quote, run, stop, type Run } from "./process.js";
import { Toolchain } from "./toolchain.js";

async function port(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No device hub port."));
      const selected = address.port;
      server.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}
const string = (value: unknown, name: string, max = 512): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
};
const number = (value: unknown, name: string, min: number, max: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
  return value;
};
const choice = (value: unknown, choices: readonly string[], name: string): string => {
  if (typeof value !== "string" || !choices.includes(value)) throw new Error(`Unsupported ${name}.`);
  return value;
};
export function validateSettings(value: unknown): DeviceSettings {
  if (!value || typeof value !== "object") throw new Error("Invalid device settings.");
  const input = value as DeviceSettings;
  if (typeof input.agentControl !== "boolean" || !Array.isArray(input.hosts) || input.hosts.length > 20) throw new Error("Invalid device settings.");
  const ids = new Set<string>();
  const hosts = input.hosts.map((host): DeviceHost => {
    const id = string(host.id, "host id", 80);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw new Error("Device hosts need distinct IDs.");
    ids.add(id);
    if (id === "local") return { id, name: string(host.name, "host name", 120) };
    const ssh = string(host.ssh, "SSH host", 200);
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(ssh)) throw new Error("Use an SSH config alias or user@host, without options.");
    const remoteDirectory = string(host.remoteDirectory, "remote directory", 1024);
    if (!remoteDirectory.startsWith("/")) throw new Error("Remote tool directory must be an absolute path.");
    return { id, name: string(host.name, "host name", 120), ssh, remoteDirectory };
  });
  if (!ids.has("local")) throw new Error("Keep the local device host.");
  return { agentControl: input.agentControl, hosts, node: string(input.node, "Node executable", 1024), npm: string(input.npm, "npm executable", 1024) };
}
interface RunningHub { origin: string; child: ChildProcess; devices: Device[] }
export class DeviceManager {
  readonly tools: Toolchain;
  private settings: DeviceSettings = structuredClone(DEFAULT_SETTINGS);
  private hubs = new Map<string, RunningHub>();
  private starting = new Map<string, Promise<RunningHub>>();
  private closed = false;
  private generation = 0;
  private agentHosts = new Map<string, DeviceHost>();
  private actions = new Map<string, Promise<unknown>>();
  private scales = new Map<string, number>();
  private load: Promise<void>;
  constructor(readonly directory: string, private execute: Run = run, private request: typeof fetch = fetch) {
    this.tools = new Toolchain(directory, execute);
    this.load = readFile(join(directory, "settings.json"), "utf8").then((text) => { this.settings = validateSettings(JSON.parse(text)); }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    this.load.catch(() => undefined);
  }
  async configure(value: unknown): Promise<HubState> {
    await this.load;
    const settings = validateSettings(value);
    await mkdir(this.directory, { recursive: true });
    const pending = join(this.directory, "settings.pending.json");
    await writeFile(pending, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
    await rename(pending, join(this.directory, "settings.json"));
    this.generation++;
    for (const hub of this.hubs.values()) stop(hub.child);
    this.hubs.clear(); this.scales.clear();
    this.settings = settings;
    return this.state();
  }
  async state(checkLatest = false): Promise<HubState> {
    await this.load;
    return { settings: structuredClone(this.settings), tools: await this.tools.states(checkLatest), devices: [...this.hubs.values()].flatMap((hub) => hub.devices) };
  }
  async consent(): Promise<void> {
    await this.load;
    if (!this.settings.agentControl) throw new Error("Agent device control is off. Enable it in Settings → Devices before asking an agent to use a device.");
  }
  private host(id: string): DeviceHost {
    const host = this.settings.hosts.find((entry) => entry.id === id);
    if (!host) throw new Error("This device host was removed. Refresh the device list.");
    return host;
  }
  private remoteEntry(host: DeviceHost, tool: "hub" | "agent"): string {
    return `${host.remoteDirectory}/tools/${TOOLS[tool].package}/${TOOLS[tool].version}/node_modules/${TOOLS[tool].package}/${TOOLS[tool].entry}`;
  }
  private async hostRun(host: DeviceHost, command: string, args: string[], signal?: AbortSignal): Promise<string> {
    const result = host.ssh
      ? await this.execute("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", host.ssh, [command, ...args].map(quote).join(" ")], { signal })
      : await this.execute(command, args, { signal });
    return result.stdout;
  }
  async install(tool: "hub" | "agent", hostId: string): Promise<HubState> {
    await this.load;
    if (tool !== "hub" && tool !== "agent") throw new Error("Unknown device tool.");
    const host = this.host(hostId);
    if (!host.ssh) await this.tools.install(tool, this.settings);
    else {
      const spec = TOOLS[tool], root = `${host.remoteDirectory}/tools/${spec.package}/${spec.version}`;
      // Paths and package names are quoted. No input becomes a shell option.
      const script = `set -eu\nroot=${quote(root)}\nif [ -f "$root/.complete" ] && [ -f ${quote(this.remoteEntry(host, tool))} ]; then exit 0; fi\nparent=${quote(`${host.remoteDirectory}/tools/${spec.package}`)}\nmkdir -p "$parent"\nstage=$(mktemp -d "$parent/.install-XXXXXX")\ntrap 'rm -rf "$stage"' EXIT\nnpm install --prefix "$stage" --no-audit --no-fund ${quote(`${spec.package}@${spec.version}`)}\ntest -f "$stage/node_modules/${spec.package}/${spec.entry}"\nprintf '%s\\n' ${quote(spec.version)} > "$stage/.complete"\nif [ -e "$root" ]; then echo 'Incomplete target exists; remove it on the device host before retrying.' >&2; exit 1; fi\nmv "$stage" "$root"`;
      await this.execute("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", host.ssh, `sh -c ${quote(script)}`], { timeout: 300_000 });
    }
    return this.state();
  }
  private async hub(hostId: string): Promise<RunningHub> {
    await this.load;
    if (this.closed) throw new Error("Devices kit is stopped.");
    const current = this.hubs.get(hostId);
    if (current && current.child.exitCode === null) return current;
    const active = this.starting.get(hostId);
    if (active) return active;
    const starting = this.startHub(this.host(hostId)).finally(() => this.starting.delete(hostId));
    this.starting.set(hostId, starting);
    return starting;
  }
  private async startHub(host: DeviceHost): Promise<RunningHub> {
    if (!host.ssh && !await this.tools.installed("hub")) throw new Error("Install the device viewer tools in Settings → Devices first.");
    const generation = this.generation;
    const localPort = await port(), remotePort = host.ssh ? await port() : localPort;
    const args = [host.ssh ? this.remoteEntry(host, "hub") : this.tools.entry("hub"), "--port", String(remotePort), "--host", "127.0.0.1", "--hide-sidebar", "--hide-boot-device"];
    const child = host.ssh
      ? spawn("ssh", ["-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, "--", host.ssh, ["env", "EXPO_DEVICE_HUB_BASE_PATH=", "node", ...args].map(quote).join(" ")], { stdio: ["ignore", "pipe", "pipe"] })
      : spawn(this.settings.node, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", EXPO_DEVICE_HUB_BASE_PATH: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let failure = "", spawnError: Error | undefined;
    child.on("error", (error) => { spawnError = error; });
    child.stdout?.resume();
    child.stderr?.on("data", (chunk: Buffer) => { failure = (failure + chunk.toString()).slice(-4000); });
    const hub: RunningHub = { origin: `http://127.0.0.1:${localPort}`, child, devices: [] };
    try {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (this.closed || generation !== this.generation || spawnError || child.exitCode !== null) throw new Error(spawnError?.message || failure || "Device hub stopped before it was ready.");
        try {
          const response = await this.request(`${hub.origin}/api/devices`, { signal: AbortSignal.timeout(1500) });
          if (response.ok) { this.hubs.set(host.id, hub); return hub; }
        } catch { /* The loopback listener is still starting. */ }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error(failure || "Device hub did not become ready in 30 seconds.");
    } catch (error) { stop(child); throw error; }
  }
  private async json(hub: RunningHub, path: string, body?: unknown): Promise<unknown> {
    const response = await this.request(hub.origin + path, { method: body === undefined ? "GET" : "POST", ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Device hub request failed (${response.status}).`);
    const result = await response.json() as { ok?: boolean; error?: string };
    if (result.ok === false) throw new Error(result.error || "Device hub rejected the action.");
    return result;
  }
  async discover(hostId: string): Promise<Device[]> {
    const hub = await this.hub(hostId);
    const result = await this.json(hub, "/api/devices") as { simulators?: Device[]; emulators?: Device[] };
    if (!Array.isArray(result.simulators) || !Array.isArray(result.emulators)) throw new Error("Device hub returned an invalid device list.");
    hub.devices = [...result.simulators, ...result.emulators].filter((device) => device.platform === "ios" || device.platform === "android").map((device) => ({ ...device, hostId }));
    // The hub omits never-used AVDs. Listing SDK AVD names is read-only.
    try {
      const names = (await this.hostRun(this.host(hostId), "emulator", ["-list-avds"])).split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
      for (const name of names) if (!hub.devices.some((device) => device.platform === "android" && device.name === name)) hub.devices.push({ id: name, hostId, name, platform: "android", version: "Android", booted: false, physical: false });
    } catch { /* An iOS-only host has no Android SDK. The hub still lists its simulators. */ }
    return hub.devices;
  }
  private async target(input: Target): Promise<{ device: Device; hub: RunningHub; host: DeviceHost }> {
    const hostId = string(input.hostId, "host id", 80), deviceId = string(input.deviceId, "device id", 512);
    const hub = await this.hub(hostId);
    const devices = hub.devices.some((entry) => entry.id === deviceId) ? hub.devices : await this.discover(hostId);
    const device = devices.find((entry) => entry.id === deviceId);
    if (!device) throw new Error("The device is no longer available. Refresh the device list.");
    if (device.physical) throw new Error("Devices supports simulators and emulators only.");
    return { device, hub, host: this.host(hostId) };
  }
  async frame(input: Target): Promise<{ dataUrl: string; capturedAt: number }> {
    const { device, hub } = await this.target(input);
    if (!device.booted) throw new Error("Boot the device to view its screen.");
    const response = await this.request(`${hub.origin}/vendor/serve-${device.platform === "ios" ? "sim" : "emu"}/api/screenshot?device=${encodeURIComponent(device.id)}`, { method: "POST", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Device screenshot failed (${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 12 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error("Device viewer did not return a PNG screenshot.");
    return { dataUrl: `data:image/png;base64,${bytes.toString("base64")}`, capturedAt: Date.now() };
  }
  async action(input: ActionInput, signal?: AbortSignal, agent = false): Promise<unknown> {
    const id = `${string(input.hostId, "host id", 80)}/${string(input.deviceId, "device id")}`;
    const previous = this.actions.get(id) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(async () => {
      if (signal?.aborted) throw new Error("Device operation cancelled.");
      if (agent) await this.consent();
      return this.performAction(input, signal);
    });
    this.actions.set(id, work);
    return work.finally(() => { if (this.actions.get(id) === work) this.actions.delete(id); });
  }
  private async performAction(input: ActionInput, signal?: AbortSignal): Promise<unknown> {
    const { device, hub, host } = await this.target(input);
    if (input.action === "boot" || input.action === "shutdown") {
      const path = input.action === "shutdown" && device.platform === "ios" ? "/vendor/serve-sim/grid/api/shutdown" : `/api/devices/${input.action}`;
      const result = await this.json(hub, path, path.includes("grid") ? { udid: device.id } : { platform: device.platform, id: device.id, name: device.name });
      if (input.action === "boot" && device.platform === "ios") await this.json(hub, "/vendor/serve-sim/grid/api/start", { udid: device.id });
      await this.discover(host.id);
      return result;
    }
    if (!device.booted) throw new Error("Boot the device before controlling it.");
    const ios = device.platform === "ios";
    const native = (command: string, args: string[]) => this.hostRun(host, command, args, signal);
    const simctl = (verb: string, args: string[]) => native("xcrun", ["simctl", verb, device.id, ...args]);
    const adb = (args: string[]) => native("adb", ["-s", device.id, ...args]);
    const shell = (args: string[]) => adb(["shell", ...args]);
    switch (input.action) {
      case "appearance": {
        const value = choice(input.value, ["light", "dark"], "appearance");
        return ios ? simctl("ui", ["appearance", value]) : shell(["cmd", "uimode", "night", value === "dark" ? "yes" : "no"]);
      }
      case "textSize": {
        const value = choice(input.value, ["small", "default", "large", "extra-large"], "text size");
        const sizes: Record<string, string> = ios ? { small: "small", default: "large", large: "extra-extra-large", "extra-large": "accessibility-large" } : { small: "0.85", default: "1.0", large: "1.15", "extra-large": "1.3" };
        return ios ? simctl("ui", ["content_size", sizes[value]]) : shell(["settings", "put", "system", "font_scale", sizes[value]]);
      }
      case "location": {
        const latitude = number(input.latitude, "latitude", -90, 90), longitude = number(input.longitude, "longitude", -180, 180);
        return ios ? simctl("location", ["set", `${latitude},${longitude}`]) : adb(["emu", "geo", "fix", String(longitude), String(latitude)]);
      }
      case "clearLocation": if (!ios) throw new Error("Android does not support clearing the emulator location. Set another location instead."); return simctl("location", ["clear"]);
      case "permission": {
        const app = string(input.appId, "app identifier", 200);
        if (!/^[a-zA-Z0-9_.]+$/.test(app)) throw new Error("Invalid app identifier.");
        const permission = choice(input.permission, ["camera", "microphone", "location", "contacts", "calendar"], "permission");
        const decision = choice(input.value, ["grant", "revoke"], "permission decision");
        if (ios) return simctl("privacy", [decision, permission, app]);
        const permissions: Record<string, string> = { camera: "CAMERA", microphone: "RECORD_AUDIO", location: "ACCESS_FINE_LOCATION", contacts: "READ_CONTACTS", calendar: "READ_CALENDAR" };
        return shell(["pm", decision, app, `android.permission.${permissions[permission]}`]);
      }
      case "accessibility": {
        if (typeof input.enabled !== "boolean") throw new Error("Choose an accessibility value.");
        const setting = choice(input.value, ios ? ["reduceMotion", "increaseContrast", "reduceTransparency", "voiceOver"] : ["reduceMotion"], "accessibility setting");
        if (ios && setting === "increaseContrast") return simctl("ui", ["increase_contrast", input.enabled ? "enabled" : "disabled"]);
        if (!ios) {
          for (const key of ["animator_duration_scale", "transition_animation_scale", "window_animation_scale"]) await shell(["settings", "put", "global", key, input.enabled ? "0" : "1"]);
          return "ok";
        }
        const options: Record<string, string> = { reduceMotion: "reduce-motion", reduceTransparency: "reduce-transparency", voiceOver: "voiceover" };
        const root = host.ssh ? `${host.remoteDirectory}/tools/${TOOLS.hub.package}/${TOOLS.hub.version}` : this.tools.root("hub");
        const helper = `${root}/node_modules/expo-device-hub/vendor/serve-sim/dist/simax/serve-sim-ax-settings`;
        return simctl("spawn", [helper, "set", options[setting], input.enabled ? "on" : "off"]);
      }
      case "fold": if (typeof input.enabled !== "boolean") throw new Error("Choose a fold posture."); if (ios) throw new Error("Fold controls require an Android foldable emulator."); return this.json(hub, `/vendor/serve-emu/api/fold?device=${encodeURIComponent(device.id)}`, { posture: input.enabled ? "closed" : "opened" });
      default: return this.agentAction(host, device, input, signal);
    }
  }
  private async screenScale(host: DeviceHost, device: Device): Promise<number> {
    if (device.platform !== "ios") return 1;
    const key = `${host.id}/${device.id}`;
    const known = this.scales.get(key);
    if (known !== undefined) return known;
    const value = Number((await this.hostRun(host, "xcrun", ["simctl", "getenv", device.id, "SIMULATOR_MAINSCREEN_SCALE"])).trim());
    if (!Number.isFinite(value) || value <= 0 || value > 8) throw new Error("Cannot read iOS screenshot scale. Device input was not sent.");
    this.scales.set(key, value);
    return value;
  }
  private async agentAction(host: DeviceHost, device: Device, input: ActionInput, signal?: AbortSignal): Promise<string> {
    if (!host.ssh && !await this.tools.installed("agent")) throw new Error("Install agent-device in Settings → Devices to send device input.");
    const entry = host.ssh ? this.remoteEntry(host, "agent") : this.tools.entry("agent");
    const target = ["--platform", device.platform, device.platform === "ios" ? "--udid" : "--serial", device.id, "--session", `tau-${host.id}-${device.id.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`, "--state-dir", host.ssh ? `${host.remoteDirectory}/agent-state` : join(this.directory, "agent-state")];
    let args: string[];
    const scale = input.action === "tap" || input.action === "swipe" ? await this.screenScale(host, device) : 1;
    const coordinate = (value: unknown, name: string) => String(number(value, name, 0, 10000) / scale);
    switch (input.action) {
      case "home": args = ["home"]; break;
      case "back": if (device.platform !== "android") throw new Error("Back is available on Android only."); args = ["back", "--system"]; break;
      case "rotate": args = ["orientation", choice(input.value, ["portrait", "landscape-left", "landscape-right", "portrait-upside-down"], "orientation")]; break;
      case "tap": args = ["click", coordinate(input.x, "x"), coordinate(input.y, "y")]; break;
      case "swipe": args = ["swipe", coordinate(input.x, "x"), coordinate(input.y, "y"), coordinate(input.endX, "end x"), coordinate(input.endY, "end y")]; break;
      case "text": args = ["type", string(input.value, "text", 4000)]; break;
      case "open": args = ["open", string(input.appId, "app identifier", 200)]; break;
      case "snapshot": args = ["snapshot", "-i"]; break;
      default: throw new Error("Unsupported device action.");
    }
    this.agentHosts.set(host.id, { ...host });
    return this.hostRun(host, host.ssh ? "node" : this.settings.node, [entry, ...args, ...target], signal);
  }
  dispose(): void {
    this.closed = true; this.generation++;
    for (const hub of this.hubs.values()) stop(hub.child);
    this.hubs.clear();
    for (const host of this.agentHosts.values()) {
      const entry = host.ssh ? this.remoteEntry(host, "agent") : this.tools.entry("agent");
      const directory = host.ssh ? `${host.remoteDirectory}/agent-state` : join(this.directory, "agent-state");
      void this.hostRun(host, host.ssh ? "node" : this.settings.node, [entry, "daemon", "stop", "--clean", "--state-dir", directory]).catch(() => undefined);
    }
    this.agentHosts.clear();
  }
}
