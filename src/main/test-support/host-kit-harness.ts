import type { GlobalHostEvent } from "../../shared/contracts.js";
import {
  HostExtensionRegistry, type HostExtension, type HostExtensionServices, type HostMcpInstructionsProvider, type HostMcpServices, type HostMcpToolGate, type HostMcpToolProvider,
} from "../host-extensions.js";
import { McpEndpoint } from "../mcp-endpoint.js";

/** An `extension-event` a kit published, as its desktop half receives it. */
export interface PublishedKitEvent {
  type: "extension-event";
  extensionId: string;
  name: string;
  payload?: unknown;
  topic?: string;
}

/**
 * A host extension registry over a stub facade, for a kit's own tests. Kits
 * live outside `src/`, so this is the one host module they may reach for —
 * everything else has to come through `tau/host-extension`.
 *
 * `publish` receives what the kit emitted; a kit that asserts on its events
 * collects them into a `PublishedKitEvent[]`.
 */
export function activateHostKit(
  extension: HostExtension,
  services: Partial<HostExtensionServices> = {},
  publish: (event: PublishedKitEvent) => void = () => undefined,
): Promise<HostExtensionRegistry> {
  const registry = new HostExtensionRegistry({
    cwd: () => "/project",
    complete: async () => "",
    agentDir: "/agent",
    sessionsDir: "/agent/sessions",
    stateDir: "/state",
    themesDir: "/themes",
    safeMode: false,
    log: () => undefined,
    // Nothing is watched in a kit's own test; a kit that follows config changes
    // still activates, and its test drives the listener it passes here.
    observeConfigChanges: () => () => undefined,
    registerThreadLifecycle: () => () => undefined,
    registerTurnObserver: () => () => undefined,
    registerRuntimeExtension: () => () => undefined,
    // No MCP endpoint in a kit's own test; a kit that offers tools passes its own fake.
    mcp: { registerTools: () => () => undefined, gate: () => () => undefined, registerInstructions: () => () => undefined, connect: async () => undefined },
    ...services,
  } as HostExtensionServices, (event: GlobalHostEvent) => {
    if (event.type === "extension-event") publish(event);
  });
  return registry.activate(extension).then(() => registry);
}

/**
 * The host's real MCP endpoint behind `services.mcp`, for a kit whose tools
 * other runtimes reach: an MCP client then stands in for such a runtime.
 * `confirm` answers the questions a gate asks in the thread.
 */
export function kitMcpEndpoint(confirm: (threadId: string, title: string, message: string) => boolean | Promise<boolean>): { mcp: HostMcpServices; close(): Promise<void> } {
  const providers = new Set<HostMcpToolProvider>();
  const gates: HostMcpToolGate[] = [];
  const instructions: HostMcpInstructionsProvider[] = [];
  const endpoint = new McpEndpoint({
    providers: () => providers,
    gates: () => gates,
    instructions: () => instructions,
    confirm: async (threadId, title, message) => confirm(threadId, title, message),
    log: () => undefined,
  });
  const remove = <T>(list: T[], item: T) => () => { const index = list.indexOf(item); if (index >= 0) list.splice(index, 1); };
  return {
    mcp: {
      registerTools: (provider) => { providers.add(provider); return () => { providers.delete(provider); }; },
      gate: (gate) => { gates.push(gate); return remove(gates, gate); },
      registerInstructions: (provider) => { instructions.push(provider); return remove(instructions, provider); },
      connect: (thread, options) => endpoint.connect(thread, options),
    },
    close: () => endpoint.close(),
  };
}
