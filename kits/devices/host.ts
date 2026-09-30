import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { HostCommandError, type HostExtension } from "tau/host-extension";
import { DeviceManager } from "./manager.js";
import { DEVICE_KIT, type ActionInput, type Target } from "./protocol.js";

// oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous SDK tool definitions use the SDK AnyTool shape.
type AnyTool = ToolDefinition<TSchema, any, any>;
export function deviceTools(manager: DeviceManager): AnyTool[] {
  const target = { hostId: Type.String({ description: "Configured host ID, local by default" }), deviceId: Type.String({ description: "Exact device ID from device_list" }) };
  const result = (value: unknown) => ({ details: {}, content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
  return [
    {
      name: "device_list", label: "List devices", description: "Discover iOS simulators and Android emulators on a configured host. Requires explicit agent device consent in Settings → Devices.",
      parameters: Type.Object({ hostId: Type.Optional(Type.String()) }),
      execute: async (_id: string, input: { hostId?: string }) => { await manager.consent(); return result(await manager.discover(input.hostId ?? "local")); },
    },
    {
      name: "device_screenshot", label: "Device screenshot", description: "Capture the selected booted device's current screen. Coordinates use image pixels. Agent consent is required.",
      parameters: Type.Object(target),
      execute: async (_id: string, input: Target) => {
        await manager.consent();
        const frame = await manager.frame(input);
        return { details: {}, content: [{ type: "image" as const, data: frame.dataUrl.slice("data:image/png;base64,".length), mimeType: "image/png" }] };
      },
    },
    {
      name: "device_control", label: "Control device", description: "Boot, shut down, open an app, inspect its accessibility snapshot, send input, or change device settings. Use exact device IDs from device_list. Open an app before snapshot or input. Agent consent is required. Back/fold are Android only; clearLocation is iOS only. Fold requires a foldable emulator. appearance: light/dark. textSize: small/default/large/extra-large. rotate: portrait/landscape-left/landscape-right/portrait-upside-down. permission: camera/microphone/location/contacts/calendar with grant/revoke and appId. accessibility: reduceMotion, iOS also increaseContrast/reduceTransparency/voiceOver, with enabled.",
      parameters: Type.Object({ ...target, action: Type.Union(["boot", "shutdown", "open", "snapshot", "home", "back", "rotate", "tap", "swipe", "text", "appearance", "textSize", "location", "clearLocation", "permission", "accessibility", "fold"].map((action) => Type.Literal(action))), value: Type.Optional(Type.String()), appId: Type.Optional(Type.String()), permission: Type.Optional(Type.String()), enabled: Type.Optional(Type.Boolean()), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), endX: Type.Optional(Type.Number()), endY: Type.Optional(Type.Number()), latitude: Type.Optional(Type.Number()), longitude: Type.Optional(Type.Number()) }),
      execute: async (_id: string, input: ActionInput, signal?: AbortSignal) => { await manager.consent(); return result(await manager.action(input, signal, true)); },
    },
  ];
}
export default {
  id: DEVICE_KIT,
  name: "Devices",
  permissions: ["runtime:extend", "process", "network"],
  activate(context) {
    const manager = new DeviceManager(context.services.stateDir);
    const guarded = (work: (input: unknown) => unknown) => async (input: unknown) => {
      try { return await work(input); } catch (error) { throw new HostCommandError(error instanceof Error ? error.message : String(error)); }
    };
    context.registerCommand("state", guarded(() => manager.state()), { access: "read" });
    context.registerCommand("check-versions", guarded(() => manager.state(true)), { access: "read" });
    context.registerCommand("configure", guarded((input) => manager.configure(input)), { access: "owner" });
    context.registerCommand("install", guarded((input) => { const request = input as { tool: "hub" | "agent"; hostId: string }; return manager.install(request.tool, request.hostId); }), { access: "owner" });
    context.registerCommand("discover", guarded((input) => manager.discover((input as { hostId: string }).hostId)), { access: "read" });
    context.registerCommand("frame", guarded((input) => manager.frame(input as Target)), { access: "read" });
    context.registerCommand("action", guarded((input) => manager.action(input as ActionInput)));
    const releasePi = context.services.registerRuntimeExtension("tau-devices", (pi) => { for (const tool of deviceTools(manager)) pi.registerTool(tool); });
    const releaseMcp = context.services.mcp.registerTools(() => deviceTools(manager));
    return () => { releasePi(); releaseMcp(); manager.dispose(); };
  },
} satisfies HostExtension;
