export const DEVICE_KIT = "tau.devices";
export const TOOLS = {
  hub: { package: "expo-device-hub", version: "0.12.0", entry: "dist/server/cli.mjs" },
  agent: { package: "agent-device", version: "0.21.12", entry: "bin/agent-device.mjs" },
} as const;
export type Platform = "ios" | "android";
export interface Device { id: string; hostId: string; platform: Platform; name: string; version: string; booted: boolean; physical?: boolean }
export interface DeviceHost { id: string; name: string; ssh?: string; remoteDirectory?: string }
export interface DeviceSettings { agentControl: boolean; hosts: DeviceHost[]; node: string; npm: string }
export const DEFAULT_SETTINGS: DeviceSettings = { agentControl: false, hosts: [{ id: "local", name: "This machine" }], node: "node", npm: "npm" };
export interface ToolState { tool: "hub" | "agent"; package: string; required: string; installed: boolean; latest?: string }
export interface HubState { settings: DeviceSettings; tools: ToolState[]; devices: Device[] }
export interface Target { hostId: string; deviceId: string }
export type DeviceAction = "boot" | "shutdown" | "home" | "back" | "rotate" | "tap" | "swipe" | "text" | "appearance" | "textSize" | "location" | "clearLocation" | "permission" | "accessibility" | "fold" | "open" | "snapshot";
export interface ActionInput extends Target { action: DeviceAction; value?: string; x?: number; y?: number; endX?: number; endY?: number; latitude?: number; longitude?: number; appId?: string; permission?: string; enabled?: boolean }
