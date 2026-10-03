import { HostCommandError, type HostExtension, type HostExtensionContext, type RuntimeExtensionFactory } from "tau/host-extension";
import { pinnedWindowCalls } from "../_host-window/pinned-calls.js";
import { ScreenRemote, type ToolRunResult } from "./remote-control.js";
import {
  COMPUTER_USE_EXTENSION_ID,
  COMPUTER_USE_PACKAGE,
  COMPUTER_USE_RUNTIME_EXTENSION,
  COMPUTER_USE_SCREEN_RUNTIME_EXTENSION,
  COMPUTER_USE_TOOL_PREFIX,
  SCREEN_CALLERS,
  SCREEN_EVENT,
  type ScreenAccess,
} from "./protocol.js";
import { ScreenFeed } from "./screen-feed.js";

type PiPackageSource = string | { source: string; autoload?: boolean };
interface PackageSettings { packages?: PiPackageSource[] }

type PiApi = Parameters<RuntimeExtensionFactory>[0];
type PiContext = Parameters<Parameters<PiApi["on"]>[1]>[1];
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
  // The driven window is on the host's machine, and so is the one capture of it.
  const remote = pinnedWindowCalls(context.services);
  return (command, input) => {
    if (process.type !== "browser") return remote.call(command, input);
    local ??= import("./window.js").then(({ default: activate }) => {
      const half = activate({ id: COMPUTER_USE_EXTENSION_ID, invokeHost: () => Promise.reject(new Error("No host commands from here.")), log: () => undefined });
      return async (next: string, nextInput?: unknown) => half.handle(next, nextInput);
    });
    return local.then((call) => call(command, input));
  };
}

/** The host owns one driver per thread and offers it through Pi and MCP. */
export function createComputerUseHostExtension(): HostExtension {
  return {
    id: COMPUTER_USE_EXTENSION_ID,
    name: "Computer Use",
    permissions: ["runtime:extend", "sessions", "packages"],
    async activate(context: HostExtensionContext) {
      let runtime: import("./runtime.js").ComputerUseRuntime | undefined;
      let loading: Promise<import("./runtime.js").ComputerUseRuntime> | undefined;
      const feed = new ScreenFeed((state) => context.emit(SCREEN_EVENT, state), { canBringToFront: (threadId) => runtime?.has(threadId) ?? false });
      const getRuntime = () => loading ??= import("./runtime.js").then(({ loadComputerUseRuntime }) => loadComputerUseRuntime(context, feed)).then((loaded) => runtime = loaded).catch((error: unknown) => { loading = undefined; throw error; });
      const drivers = {
        run: async (threadId: string, name: string, args: Record<string, unknown>): Promise<ToolRunResult> => (await getRuntime()).remote(threadId, name, args),
        bringToFront: async (threadId: string, pid: number, windowId: number | undefined) => {
          const result = await (await getRuntime()).remote(threadId, `${COMPUTER_USE_TOOL_PREFIX}bring_to_front`, { pid, ...(windowId === undefined ? {} : { window_id: windowId }) });
          if (result.isError) throw new Error(result.content.map((item) => item.type === "text" ? item.text : "").join(" "));
        },
      };
      const callWindow = windowCalls(context);
      const icons = new Map<number, Promise<string | null>>();

      const releaseDriver = context.services.registerRuntimeExtension(COMPUTER_USE_RUNTIME_EXTENSION, async (pi, session) => (await getRuntime()).piFactory()(pi, session), {
        enabledFor: (settings) => !settingsIncludeComputerUse(settings.global as PackageSettings) && !settingsIncludeComputerUse(settings.project as PackageSettings),
      });
      // The shared driver records its own calls; this observer serves configured external Pi packages.
      const externalObserver = screenObserver(feed);
      const releaseObserver = context.services.registerRuntimeExtension(COMPUTER_USE_SCREEN_RUNTIME_EXTENSION, (pi, session) => {
        if (!runtime?.has(session.sessionId)) return externalObserver(pi, session);
      });
      const releaseTools = context.services.mcp.registerTools(async (thread) => thread.nativeCapabilities?.includes("computer-use") ? [] : (await getRuntime()).tools(thread));
      const releaseGate = context.services.mcp.gate(async (call) => {
        if (!call.toolName.startsWith(COMPUTER_USE_TOOL_PREFIX)) return;
        try {
          await (await getRuntime()).approve({ sessionId: call.threadId, cwd: call.cwd }, call.toolName, call.input, call.signal, ({ title, message }) => call.confirm(title, message));
        } catch (error) {
          return { block: true, reason: error instanceof Error ? error.message : String(error) };
        }
      });
      const releaseLifecycle = context.services.registerTurnObserver({ closed: async (threadId) => {
        feed.forget(threadId);
        // A pending provider resumes first and creates its state; close that state too.
        const active = runtime ?? await loading?.catch(() => undefined);
        await active?.closeThread(threadId);
      } });

      // The live view records the window the feed names, never one a client asks for by id.
      const windowOf = (input: unknown): number => {
        const windowId = feed.target(threadIdOf(input))?.windowId;
        if (windowId === undefined) throw new Error("The agent of this thread drives no window yet.");
        return windowId;
      };
      // Evidence Kit keeps the frames the feed lets go of after three.
      // A Read-only device may watch the window, so looking is a read.
      context.registerCommand("screen-state", (input) => feed.state(threadIdOf(input)) ?? null, { callers: SCREEN_CALLERS, access: "read" });
      context.registerCommand("screen-frame", (input) => {
        const seq = (input as { seq?: unknown }).seq;
        return feed.frame(threadIdOf(input), typeof seq === "number" ? seq : undefined);
      }, { callers: SCREEN_CALLERS, access: "read" });
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
      }, { access: "read" });
      context.registerCommand("screen-access", async (): Promise<ScreenAccess> => {
        try {
          return await callWindow("access") as ScreenAccess;
        } catch {
          return "unavailable";
        }
      }, { access: "read" });
      context.registerCommand("screen-access-settings", () => callWindow("open-settings"));
      context.registerCommand("screen-live-start", (input) => callWindow("live-start", { windowId: windowOf(input) }));
      context.registerCommand("screen-live-frame", (input) => callWindow("live-frame", { windowId: windowOf(input) }));
      context.registerCommand("screen-live-stop", (input) => {
        const windowId = feed.target(threadIdOf(input))?.windowId;
        return windowId === undefined ? undefined : callWindow("live-stop", { windowId });
      });

      // Decision 7: a device that shows the window may drive it, through the thread's own driver.
      const remote = new ScreenRemote({
        target: (threadId) => feed.target(threadId),
        frame: (threadId) => feed.frame(threadId),
        run: (threadId, tool, params) => drivers.run(threadId, tool, params),
        looked: (threadId, params, result) => feed.toolResult(threadId, `${COMPUTER_USE_TOOL_PREFIX}get_window_state`, params, `tau-remote-look-${String(Date.now())}`, result),
        callWindow,
        now: () => Date.now(),
      });
      context.registerCommand("screen-view-frame", (input) => remote.frame(threadIdOf(input), (input ?? {}) as Record<string, unknown>), { access: "read" });
      context.registerCommand("screen-input", (input) => remote.input(threadIdOf(input), (input as { input?: unknown }).input).catch((error: unknown) => {
        throw new HostCommandError(error instanceof Error ? error.message : String(error));
      }));

      return () => {
        remote.dispose();
        releaseDriver();
        releaseObserver();
        releaseTools();
        releaseGate();
        releaseLifecycle();
        void loading?.then((loaded) => loaded.close()).catch(() => undefined);
        void callWindow("live-stop").catch(() => undefined);
      };
    },
  };
}

export default createComputerUseHostExtension;
