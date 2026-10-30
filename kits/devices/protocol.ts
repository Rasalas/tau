export const DEVICE_KIT = "tau.devices";
export const TOOLS = {
  hub: { package: "expo-device-hub", version: "0.12.0", entry: "dist/server/cli.mjs" },
  agent: { package: "agent-device", version: "0.21.12", entry: "bin/agent-device.mjs" },
} as const;
export type Platform = "ios" | "android";
export interface Device { id: string; hostId: string; platform: Platform; name: string; version: string; booted: boolean; physical?: boolean }
/** Native emulator status, never inferred from a name or a requested action. */
export interface FoldState { supported: boolean; posture: "closed" | "half_opened" | "opened" | "flipped" | "tent" | null; hingeAngle: number | null }
/** `forwardPorts`: remote loopback ports that reach the same port on this machine (Metro's 8081) through `ssh -R`. */
export interface DeviceHost { id: string; name: string; ssh?: string; remoteDirectory?: string; forwardPorts?: number[] }
export const MAX_FORWARD_PORTS = 8;
/** The port tunnel of one SSH machine. `error` is the last failure, kept until the tunnel runs again. */
export interface TunnelState { ports: number[]; status: "connecting" | "running" | "failed"; error?: string }
/** One configured machine as `device_list` reports it without a host ID: its devices, or why they could not be read. */
export interface DeviceHostListing { id: string; name: string; remote: boolean; ssh?: string; tunnel?: TunnelState; devices?: Device[]; error?: string }
export interface DeviceSettings { agentControl: boolean; hosts: DeviceHost[]; node: string; npm: string }
export const DEFAULT_SETTINGS: DeviceSettings = { agentControl: false, hosts: [{ id: "local", name: "This machine" }], node: "node", npm: "npm" };
export interface ToolState { tool: "hub" | "agent"; package: string; required: string; installed: boolean; latest?: string }
export interface HubState { settings: DeviceSettings; tools: ToolState[]; devices: Device[]; tunnels?: Record<string, TunnelState> }
/** What `device_sync_project` and the `sync-project` command report. */
export interface ProjectSyncResult { hostId: string; hostName: string; ssh: string; projectPath: string; remotePath: string; files: number; bytes: number; removed: number; forwardPorts: number[]; hint: string }
export interface Target { hostId: string; deviceId: string }
export type DeviceAction = "boot" | "shutdown" | "home" | "back" | "rotate" | "tap" | "swipe" | "text" | "appearance" | "textSize" | "location" | "clearLocation" | "permission" | "accessibility" | "fold" | "open" | "snapshot";
export interface ActionInput extends Target { action: DeviceAction; value?: string; x?: number; y?: number; endX?: number; endY?: number; latitude?: number; longitude?: number; appId?: string; permission?: string; enabled?: boolean }
