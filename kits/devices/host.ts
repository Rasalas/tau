import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { HostCommandError, type HostCommandCall, type HostExtension } from "tau/host-extension";
import { DeviceManager } from "./manager.js";
import { DeviceStreams } from "./stream-host.js";
import { isAbsolute } from "node:path";
import { DEVICE_KIT, type ActionInput, type Target } from "./protocol.js";

// oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous SDK tool definitions use the SDK AnyTool shape.
type AnyTool = ToolDefinition<TSchema, any, any>;
/** Pi loads these on demand through `tool_search`. */
const DEVICE_TOOL_GROUP = {
  exposure: "deferred" as const,
  namespace: { name: "devices", description: "iOS simulators and Android emulators: screenshot, boot, open an app, tap, settings, sync a project to a Mac." },
};
/** The thread a tool serves: its project folder, and the host's check that a named folder is a project it knows. */
export interface ToolProject { cwd?: string; known?: (path: string) => Promise<string> }
export async function projectFor(project: ToolProject, requested: string | undefined): Promise<string> {
  if (requested !== undefined) {
    if (typeof requested !== "string" || !isAbsolute(requested)) throw new Error("projectPath must be an absolute path.");
    if (!project.known) throw new Error("Cannot check that projectPath is a project open in Tau.");
    try { return await project.known(requested); } catch { throw new Error(`${requested} is not a project open in Tau.`); }
  }
  if (project.cwd) return project.cwd;
  throw new Error("This thread has no project folder. Pass projectPath, the absolute path of a project open in Tau.");
}
export function deviceTools(manager: DeviceManager, project: ToolProject = {}): AnyTool[] {
  const target = { hostId: Type.String({ description: 'Configured machine ID from device_list; "local" is this machine' }), deviceId: Type.String({ description: "Exact device ID from device_list" }) };
  const result = (value: unknown) => ({ details: {}, content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });
  return [
    {
      annotations: { readOnlyHint: true },
      name: "device_list", label: "List devices", description: "Discover iOS simulators and Android emulators. Without hostId, lists every configured machine (this one and remote SSH machines such as a Mac with Xcode) with its ID and devices, or the error that kept them unread. With hostId, lists that machine's devices. Requires explicit agent device consent in Settings → Simulators.",
      parameters: Type.Object({ hostId: Type.Optional(Type.String({ description: "A machine ID from an earlier device_list; all machines when left out" })) }),
      execute: async (_id: string, input: { hostId?: string }) => { await manager.consent(); return result(input.hostId ? await manager.discover(input.hostId) : await manager.discoverAll()); },
    },
    {
      annotations: { readOnlyHint: true },
      name: "device_screenshot", label: "Device screenshot", description: "Capture the selected booted device's current screen. Coordinates use image pixels. Agent consent is required.",
      parameters: Type.Object(target),
      execute: async (_id: string, input: Target) => {
        await manager.consent();
        const frame = await manager.frame(input);
        return { details: {}, content: [{ type: "image" as const, data: frame.dataUrl.slice("data:image/png;base64,".length), mimeType: "image/png" }] };
      },
    },
    {
      annotations: { readOnlyHint: false },
      name: "device_control", label: "Control device", description: "Boot, shut down, open an app, inspect its accessibility snapshot, send input, or change device settings. Use exact device IDs from device_list. Open an app before snapshot or input. Agent consent is required. Back/fold are Android only; clearLocation is iOS only. Fold requires a foldable emulator. appearance: light/dark. textSize: small/default/large/extra-large. rotate: portrait/landscape-left/landscape-right/portrait-upside-down. permission: camera/microphone/location/contacts/calendar with grant/revoke and appId. accessibility: reduceMotion, iOS also increaseContrast/reduceTransparency/voiceOver, with enabled.",
      parameters: Type.Object({ ...target, action: Type.Union(["boot", "shutdown", "open", "snapshot", "home", "back", "rotate", "tap", "swipe", "text", "appearance", "textSize", "location", "clearLocation", "permission", "accessibility", "fold"].map((action) => Type.Literal(action))), value: Type.Optional(Type.String()), appId: Type.Optional(Type.String()), permission: Type.Optional(Type.String()), enabled: Type.Optional(Type.Boolean()), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), endX: Type.Optional(Type.Number()), endY: Type.Optional(Type.Number()), latitude: Type.Optional(Type.Number()), longitude: Type.Optional(Type.Number()) }),
      execute: async (_id: string, input: ActionInput, signal?: AbortSignal) => { await manager.consent(); return result(await manager.action(input, signal, true)); },
    },
    {
      annotations: { readOnlyHint: false },
      name: "device_sync_project", label: "Sync project to device machine", description: "Copy this thread's project to a remote SSH machine (such as a Mac with Xcode) to build and run it there. Sends the files Git lists (tracked and untracked, not ignored) to <tool directory>/projects/<name>-<hash> and deletes files an earlier sync sent that are gone here; node_modules, Pods and build output made on that machine stay. Refuses a folder that is not a Git repository. The result names the ssh alias, the remote path, the ports forwarded to this machine (Metro), and a command to build there. Agent consent is required.",
      parameters: Type.Object({ hostId: Type.String({ description: "A remote machine ID from device_list" }), projectPath: Type.Optional(Type.String({ description: "Absolute path of a project open in Tau; this thread's project when left out" })) }),
      execute: async (_id: string, input: { hostId: string; projectPath?: string }, signal?: AbortSignal) => {
        await manager.consent();
        return result(await manager.syncProject(input.hostId, await projectFor(project, input.projectPath), signal));
      },
    },
  ];
}
export default {
  id: DEVICE_KIT,
  name: "Simulators",
  permissions: ["runtime:extend", "process", "network", "workspace:read"],
  activate(context) {
    const manager = new DeviceManager(context.services.stateDir);
    const streams = new DeviceStreams((target) => manager.streamTarget(target));
    const principal = (call: HostCommandCall) => {
      if (call.device) return `device:${call.device}`;
      if (call.owner) return "owner";
      throw new HostCommandError("Device video needs a paired device or this machine's owner.");
    };
    const guarded = (work: (input: unknown, call: HostCommandCall) => unknown) => async (input: unknown, call: HostCommandCall) => {
      try { return await work(input, call); } catch (error) { throw new HostCommandError(error instanceof Error ? error.message : String(error)); }
    };
    context.registerCommand("state", guarded(() => manager.state()), { access: "read" });
    context.registerCommand("check-versions", guarded(() => manager.state(true)), { access: "read" });
    context.registerCommand("configure", guarded((input) => { streams.closeAll(); return manager.configure(input); }), { access: "owner" });
    context.registerCommand("install", guarded((input) => { const request = input as { tool: "hub" | "agent"; hostId: string }; return manager.install(request.tool, request.hostId); }), { access: "owner" });
    context.registerCommand("discover", guarded((input) => manager.discover((input as { hostId: string }).hostId)), { access: "read" });
    context.registerCommand("fold-state", guarded((input) => manager.foldState(input as Target)), { access: "read" });
    context.registerCommand("frame", guarded((input) => manager.frame(input as Target)), { access: "read" });
    context.registerCommand("stream-open", guarded((input, call) => streams.open(input as Target, principal(call))), { access: "read" });
    context.registerCommand("stream-read", guarded((input, call) => streams.read((input as { id: string }).id, principal(call))), { access: "read" });
    context.registerCommand("stream-close", guarded((input, call) => streams.close((input as { id: string }).id, principal(call))), { access: "read" });
    context.registerCommand("action", guarded((input) => manager.action(input as ActionInput)));
    const known = (path: string) => context.services.knownWorkspacePath(path);
    // The open project by default; a named folder must be one the host knows. Control access, like device input.
    context.registerCommand("sync-project", guarded(async (input) => {
      const request = (input ?? {}) as { hostId?: string; projectPath?: string };
      return manager.syncProject(request.hostId as string, await projectFor({ cwd: context.services.cwd(), known }, request.projectPath));
    }));
    const releasePi = context.services.registerRuntimeExtension("tau-devices", (pi, session) => { for (const tool of deviceTools(manager, { cwd: session.cwd, known })) pi.registerTool({ ...tool, ...DEVICE_TOOL_GROUP }); });
    const releaseMcp = context.services.mcp.registerTools((thread) => deviceTools(manager, { cwd: thread.cwd, known }));
    return () => { releasePi(); releaseMcp(); streams.dispose(); manager.dispose(); };
  },
} satisfies HostExtension;
