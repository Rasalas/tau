import type { HostExtension, HostExtensionContext, RuntimeExtensionFactory } from "tau/host-extension";
import {
  COMPUTER_USE_EXTENSION_ID,
  COMPUTER_USE_PACKAGE,
  COMPUTER_USE_RUNTIME_EXTENSION,
  COMPUTER_USE_SCREEN_RUNTIME_EXTENSION,
  COMPUTER_USE_TOOL_PREFIX,
  SCREEN_EVENT,
  type ScreenAccess,
} from "./protocol.js";
import { ScreenFeed } from "./screen-feed.js";

type PiPackageSource = string | { source: string; autoload?: boolean };
interface PackageSettings { packages?: PiPackageSource[] }

type PiApi = Parameters<RuntimeExtensionFactory>[0];
type PiContext = Parameters<Parameters<PiApi["on"]>[1]>[1];
interface DriverTool {
  name: string;
  execute(callId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: PiContext): Promise<{ content?: { type: string; text?: string }[]; isError?: boolean }>;
}

const BRING_TO_FRONT = `${COMPUTER_USE_TOOL_PREFIX}bring_to_front`;
const FRONT_TIMEOUT_MS = 10_000;

function packageSource(entry: PiPackageSource): string {
  return typeof entry === "string" ? entry : entry.source;
}

export function settingsIncludeComputerUse(settings: PackageSettings): boolean {
  return settings.packages?.some((entry) => {
    const source = packageSource(entry);
    return source === `npm:${COMPUTER_USE_PACKAGE}`
      || source.startsWith(`npm:${COMPUTER_USE_PACKAGE}@`);
  }) ?? false;
}

/** The driver's own tools per thread, kept so the screen view's button can raise the window through them. */
class DriverHandles {
  private readonly handles = new Map<string, { tools: Map<string, DriverTool>; context?: PiContext }>();

  /** Hands the driver a `pi` that records the tools it registers; everything else passes through. */
  wrap(factory: RuntimeExtensionFactory): RuntimeExtensionFactory {
    return (pi, session) => {
      const tools = new Map<string, DriverTool>();
      const handle: { tools: Map<string, DriverTool>; context?: PiContext } = { tools };
      pi.on("session_start", (_event, ctx) => {
        handle.context = ctx;
        this.handles.set(session.sessionId, handle);
      });
      pi.on("session_shutdown", () => {
        if (this.handles.get(session.sessionId) === handle) this.handles.delete(session.sessionId);
      });
      const recording = new Proxy(pi, {
        get(target, property) {
          if (property === "registerTool") {
            return (tool: DriverTool) => {
              tools.set(tool.name, tool);
              return (target.registerTool as (tool: unknown) => void)(tool);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return factory(recording, session);
    };
  }

  has(threadId: string): boolean {
    return this.handles.get(threadId)?.tools.has(BRING_TO_FRONT) ?? false;
  }

  async bringToFront(threadId: string, pid: number, windowId: number | undefined): Promise<void> {
    const handle = this.handles.get(threadId);
    const tool = handle?.tools.get(BRING_TO_FRONT);
    if (!handle?.context || !tool) throw new Error("This thread's computer use cannot raise the window.");
    const result = await tool.execute("tau-screen-front", { pid, ...(windowId !== undefined ? { window_id: windowId } : {}) }, AbortSignal.timeout(FRONT_TIMEOUT_MS), undefined, handle.context);
    if (result.isError) throw new Error(result.content?.map((entry) => entry.text ?? "").join(" ").trim() || "The window could not be raised.");
  }
}

/** Feeds every computer-use call and result of a runtime into the screen feed. */
export function screenObserver(feed: ScreenFeed): RuntimeExtensionFactory {
  return (pi, session) => {
    const threadOf = (ctx: PiContext | undefined): string => ctx?.sessionManager?.getSessionId?.() ?? session.sessionId;
    // An observer that throws would fail the agent's tool call; it only watches.
    const watch = (work: () => void): void => {
      try {
        work();
      } catch {
        // The view misses one step; the agent does not.
      }
    };
    pi.on("tool_call", (event, ctx) => {
      if (event.toolName.startsWith(COMPUTER_USE_TOOL_PREFIX)) watch(() => feed.toolCall(threadOf(ctx), event.toolName, event.input, event.toolCallId));
      return undefined;
    });
    pi.on("tool_result", (event, ctx) => {
      if (event.toolName.startsWith(COMPUTER_USE_TOOL_PREFIX)) {
        watch(() => feed.toolResult(threadOf(ctx), event.toolName, event.input, event.toolCallId, {
          content: event.content,
          details: "details" in event ? event.details : undefined,
          isError: event.isError,
        }));
      }
      return undefined;
    });
  };
}

const threadIdOf = (input: unknown): string => {
  const threadId = (input as { threadId?: unknown } | undefined)?.threadId;
  if (typeof threadId !== "string" || !threadId) throw new Error("Name the thread whose screen to show.");
  return threadId;
};

type WindowCall = (command: string, input?: unknown) => Promise<unknown>;

/**
 * The window half runs where the user's window is. A host in the window's own
 * process (the in-process fallback) loads it directly.
 */
function windowCalls(context: HostExtensionContext): WindowCall {
  let local: Promise<WindowCall> | undefined;
  return (command, input) => {
    if (process.type !== "browser") return context.services.callClient(command, input);
    local ??= import("./window.js").then(({ default: activate }) => {
      const half = activate({ id: COMPUTER_USE_EXTENSION_ID, invokeHost: () => Promise.reject(new Error("No host commands from here.")), log: () => undefined });
      return async (next: string, nextInput?: unknown) => half.handle(next, nextInput);
    });
    return local.then((call) => call(command, input));
  };
}

/**
 * Computer Use's host entry: the npm package as a bundled Pi extension, and the
 * screen feed — the window each thread's agent drives, from the driver's own
 * screenshots and the calls it makes. The host loads the package, because its
 * driver binaries live beside the module npm installed. A user-configured Pi
 * package wins, so existing installations do not register the same tools twice;
 * the feed watches either.
 */
export function createComputerUseHostExtension(): HostExtension {
  return {
    id: COMPUTER_USE_EXTENSION_ID,
    name: "Computer Use",
    permissions: ["runtime:extend"],
    async activate(context: HostExtensionContext) {
      const drivers = new DriverHandles();
      const feed = new ScreenFeed((state) => context.emit(SCREEN_EVENT, state), { canBringToFront: (threadId) => drivers.has(threadId) });
      const callWindow = windowCalls(context);
      const icons = new Map<number, Promise<string | null>>();

      const factory = await context.services.loadRuntimeExtension(COMPUTER_USE_PACKAGE);
      const releaseDriver = context.services.registerRuntimeExtension(COMPUTER_USE_RUNTIME_EXTENSION, drivers.wrap(factory), {
        enabledFor: (settings) =>
          !settingsIncludeComputerUse(settings.global as PackageSettings)
          && !settingsIncludeComputerUse(settings.project as PackageSettings),
      });
      const releaseObserver = context.services.registerRuntimeExtension(COMPUTER_USE_SCREEN_RUNTIME_EXTENSION, screenObserver(feed));

      // The live view records the window the feed names, never one a client asks for by id.
      const windowOf = (input: unknown): number => {
        const windowId = feed.target(threadIdOf(input))?.windowId;
        if (windowId === undefined) throw new Error("The agent of this thread drives no window yet.");
        return windowId;
      };
      context.registerCommand("screen-state", (input) => feed.state(threadIdOf(input)) ?? null);
      context.registerCommand("screen-frame", (input) => {
        const seq = (input as { seq?: unknown }).seq;
        return feed.frame(threadIdOf(input), typeof seq === "number" ? seq : undefined);
      });
      context.registerCommand("screen-front", async (input) => {
        const threadId = threadIdOf(input);
        const target = feed.target(threadId);
        if (!target) throw new Error("The agent of this thread drives no window yet.");
        await drivers.bringToFront(threadId, target.pid, target.windowId);
      });
      context.registerCommand("screen-icon", (input) => {
        const pid = feed.target(threadIdOf(input))?.pid;
        if (pid === undefined) return null;
        let icon = icons.get(pid);
        if (!icon) {
          icon = callWindow("icon", { pid }).then((url) => typeof url === "string" ? url : null, () => null);
          icons.set(pid, icon);
        }
        return icon;
      });
      context.registerCommand("screen-access", async (): Promise<ScreenAccess> => {
        try {
          return await callWindow("access") as ScreenAccess;
        } catch {
          return "unavailable";
        }
      });
      context.registerCommand("screen-access-settings", () => callWindow("open-settings"));
      context.registerCommand("screen-live-start", (input) => callWindow("live-start", { windowId: windowOf(input) }));
      context.registerCommand("screen-live-frame", (input) => callWindow("live-frame", { windowId: windowOf(input) }));
      context.registerCommand("screen-live-stop", (input) => {
        const windowId = feed.target(threadIdOf(input))?.windowId;
        return windowId === undefined ? undefined : callWindow("live-stop", { windowId });
      });

      return () => {
        releaseDriver();
        releaseObserver();
        void callWindow("live-stop").catch(() => undefined);
      };
    },
  };
}

export default createComputerUseHostExtension;
