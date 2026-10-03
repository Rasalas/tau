import { compareVersions, type HostExtensionContext, type UiRuntimeTool, type UiRuntimeToolsState } from "tau/host-extension";
import { ENVIRONMENTS_EXTENSION_ID, MACHINE_TOOLS_PROGRESS, MACHINE_TOOLS_STATE, MACHINE_TOOLS_UPDATE, LOCAL_STATE, LOCAL_UPDATE, type MachineTools } from "./protocol.js";

export function pendingTool(tool: UiRuntimeTool): boolean {
  return Boolean(tool.update && tool.installed && tool.latest && compareVersions(tool.installed, tool.latest) < 0);
}

/** Each receiving host runs its own maintenance, including its busy-turn queue. */
export function registerRuntimeToolCommands(context: HostExtensionContext): void {
  const tools = context.services.runtimeTools;
  const machines = context.services.machines;
  const uncertain = new Set<string>();
  const local = { id: machines?.self.id ?? "local", name: machines?.self.name ?? "This machine", local: true };
  const read = () => {
    if (!tools) throw new Error("This Tau cannot manage agent tools. Update Tau on this machine.");
    return tools("state");
  };
  const update = async () => {
    let state = await read();
    if (state.blocked) return state;
    // One installed program may back multiple runtimes. Update it once.
    for (const tool of state.tools.filter(pendingTool)) {
      if (!tool.state && tool.kinds[0]) state = await tools!("update", { kind: tool.kinds[0] });
    }
    return state;
  };
  context.registerCommand(LOCAL_STATE, read, { access: "read", long: true });
  context.registerCommand(LOCAL_UPDATE, update, { long: true, audit: { label: "updated installed agent tools" } });

  const all = async (updating: boolean, input?: unknown): Promise<MachineTools[]> => {
    const raw = input as { machine?: unknown; requestId?: unknown } | undefined;
    const machine = raw?.machine;
    const requestId = raw?.requestId;
    if (requestId !== undefined && (typeof requestId !== "string" || requestId.length > 128)) throw new Error("Invalid agent-tools request id.");
    const publish = (entry: MachineTools): MachineTools => {
      if (requestId) context.emit(MACHINE_TOOLS_PROGRESS, { requestId, machine: entry }, { topic: MACHINE_TOOLS_PROGRESS });
      return entry;
    };
    if (machine !== undefined && (typeof machine !== "string" || !machine)) throw new Error("Name a machine to retry.");
    const targets = [local, ...(machines?.list() ?? []).filter((item) => item.id !== local.id)];
    if (machine && !targets.some((target) => target.id === machine)) throw new Error("That machine is no longer saved.");
    return Promise.all(targets.map(async (target): Promise<MachineTools> => {
      const entry = { id: target.id, name: target.name, ...(target === local ? { local: true } : {}) };
      publish({ ...entry, requesting: true });
      const change = updating && (!machine || machine === target.id) && !uncertain.has(target.id);
      if (target !== local) {
        const remote = target as ReturnType<NonNullable<typeof machines>["list"]>[number];
        if (remote.status !== "connected") return publish({ ...entry, skipped: "Disconnected" });
        if (remote.readOnly) return publish({ ...entry, skipped: "Read only" });
      }
      try {
        const state = target === local
          ? await (change ? update() : read())
          : await machines!.call(target.id, ENVIRONMENTS_EXTENSION_ID, change ? LOCAL_UPDATE : LOCAL_STATE, undefined, { timeoutMs: 120_000 }) as UiRuntimeToolsState;
        uncertain.delete(target.id);
        return publish({ ...entry, state, ...(state.blocked ? { skipped: state.blocked } : {}) });
      } catch (error) {
        const code = (error as { code?: string })?.code;
        const message = error instanceof Error ? error.message : String(error);
        const unsupported = ["unknown-command", "unknown-extension", "unknown-method"].includes(code ?? "") || /has no command|is not installed|cannot manage agent tools/u.test(message);
        if (change && !unsupported) uncertain.add(target.id);
        return publish({ ...entry, ...(unsupported ? { skipped: `Update Tau on ${target.name} to manage its agent tools.` } : { problem: uncertain.has(target.id) ? `${message} The update request may still be running; checking its state before another update.` : message, ...(uncertain.has(target.id) ? { uncertain: true } : {}) }) });
      }
    }));
  };
  context.registerCommand(MACHINE_TOOLS_STATE, (input) => all(false, input), { access: "read", long: true });
  context.registerCommand(MACHINE_TOOLS_UPDATE, (input) => all(true, input), { long: true, audit: { label: "updated installed agent tools across machines" } });
}
