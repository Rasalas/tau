import { dirname } from "node:path";
import { Type } from "typebox";
import type { HostExtensionContext, HostMcpTool, RuntimeExtensionFactory, RuntimeSessionInfo } from "tau/host-extension";
import { ComputerUseDriverSessions, loadComputerUseManifest, type ComputerUseClient } from "./driver.js";
import { ComputerUsePolicy, type ComputerUseConfig, type ComputerUseConfirm } from "./policy.js";
import { COMPUTER_USE_PACKAGE, COMPUTER_USE_TOOL_PREFIX } from "./protocol.js";
import type { ScreenFeed } from "./screen-feed.js";
import { registerComputerUseVision } from "./vision.js";

interface PackageApi {
  resolveDriverLayout(config: ComputerUseConfig): { appPath?: string };
  CuaDriverClient: new(config: ComputerUseConfig) => ComputerUseClient;
  resolveConfig(config: unknown): ComputerUseConfig;
  loadConfigFromFile(options: { cwd: string; projectTrusted: boolean }): unknown;
}
interface ThreadState {
  config: ComputerUseConfig;
  lifecycle: AbortController;
  policy: ComputerUsePolicy;
  permission?: Promise<void>;
}

/** Owns the thread driver once, while adapters supply each runtime's confirmation surface. */
export class ComputerUseRuntime {
  private readonly sessions: ComputerUseDriverSessions;
  private readonly threads = new Map<string, ThreadState>();
  private readonly approved = new WeakMap<Record<string, unknown>, Record<string, unknown>>();

  constructor(private readonly packageApi: PackageApi, private readonly feed: ScreenFeed, private readonly trusted: (cwd: string) => boolean = () => false, private readonly loadCompletion: Parameters<typeof registerComputerUseVision>[3]) {
    this.sessions = new ComputerUseDriverSessions({ createClient: (config) => new packageApi.CuaDriverClient(config), loadManifest: () => {
      const appPath = packageApi.resolveDriverLayout({ mode: "bundled" }).appPath;
      if (!appPath) throw new Error("The macOS Computer Use driver layout is unavailable.");
      return loadComputerUseManifest(dirname(dirname(dirname(appPath))));
    } });
  }

  private state(thread: RuntimeSessionInfo): ThreadState {
    let state = this.threads.get(thread.sessionId);
    if (!state) {
      const config = this.packageApi.resolveConfig(this.packageApi.loadConfigFromFile({ cwd: thread.cwd, projectTrusted: this.trusted(thread.cwd) }));
      state = { config, lifecycle: new AbortController(), policy: new ComputerUsePolicy({ cwd: thread.cwd, config }) };
      this.threads.set(thread.sessionId, state);
    }
    return state;
  }

  has(threadId: string): boolean { return this.threads.has(threadId); }

  async approve(thread: RuntimeSessionInfo, name: string, args: Record<string, unknown>, signal: AbortSignal, confirm: ComputerUseConfirm): Promise<void> {
    const state = this.state(thread);
    const active = AbortSignal.any([signal, state.lifecycle.signal]);
    const approved = await state.policy.approve(name.slice(COMPUTER_USE_TOOL_PREFIX.length), args, active, confirm);
    active.throwIfAborted();
    this.approved.set(args, approved);
  }

  private async run(thread: RuntimeSessionInfo, name: string, args: Record<string, unknown>, signal?: AbortSignal, confirm?: ComputerUseConfirm, userInput = false, callId = `tau-computer-${Date.now()}`) {
    const state = this.state(thread);
    signal = signal ? AbortSignal.any([signal, state.lifecycle.signal]) : state.lifecycle.signal;
    signal.throwIfAborted();
    const nativeName = name.slice(COMPUTER_USE_TOOL_PREFIX.length);
    const approved = userInput ? args : this.approved.get(args) ?? await state.policy.approve(nativeName, args, signal, confirm);
    this.approved.delete(args);
    signal.throwIfAborted();
    const driver = this.sessions.forThread(thread.sessionId, state.config);
    if (process.platform === "darwin" && nativeName !== "check_permissions") {
      state.permission ??= driver.call("check_permissions", { prompt: true }, signal).then(() => undefined).catch((error: unknown) => { state.permission = undefined; throw error; });
      await state.permission;
    }
    try { this.feed.toolCall(thread.sessionId, name, approved, callId); } catch { /* Observation must not fail an action. */ }
    try {
      const result = await driver.call(nativeName, approved, signal);
      if (result.isError) {
        result.content = result.content.map((item) => {
          if (item.type !== "text") return item;
          if (item.text.includes("ax_not_granted")) return { ...item, text: `${item.text}\nEnable Accessibility for the Computer Use driver in System Settings > Privacy & Security > Accessibility, then retry.` };
          if (item.text.includes("sc_not_granted")) return { ...item, text: `${item.text}\nEnable Screen Recording for the Computer Use driver in System Settings > Privacy & Security > Screen Recording, then retry.` };
          return item;
        });
      }
      try { this.feed.toolResult(thread.sessionId, name, approved, callId, result); } catch { /* Observation must not fail an action. */ }
      return result;
    } catch (error) {
      try { this.feed.toolResult(thread.sessionId, name, approved, callId, { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }); } catch { /* Preserve the driver error. */ }
      throw error;
    }
  }

  async tools(thread: RuntimeSessionInfo): Promise<HostMcpTool[]> {
    const state = this.state(thread);
    const tools = await this.sessions.forThread(thread.sessionId, state.config).listTools();
    return tools.map((tool): HostMcpTool => ({
      name: `${COMPUTER_USE_TOOL_PREFIX}${tool.name}`, label: tool.title ?? tool.name,
      description: tool.description ?? tool.name, parameters: Type.Unsafe(tool.inputSchema), executionMode: "sequential",
      execute: (id, args, signal, _update, ctx) => { state.lifecycle.signal.throwIfAborted(); return this.run(thread, `${COMPUTER_USE_TOOL_PREFIX}${tool.name}`, args as Record<string, unknown>, signal,
        ctx?.hasUI ? ({ title, message }) => ctx.ui.confirm(title, message) : undefined, false, id); },
    }));
  }

  piFactory(): RuntimeExtensionFactory {
    return async (pi, thread) => {
      const state = this.state(thread);
      pi.on("session_shutdown", () => this.closeThread(thread.sessionId));
      const register = async (signal?: AbortSignal): Promise<number> => {
        state.lifecycle.signal.throwIfAborted();
        signal?.throwIfAborted();
        const tools = await this.tools(thread);
        state.lifecycle.signal.throwIfAborted();
        signal?.throwIfAborted();
        for (const tool of tools) pi.registerTool(tool);
        return tools.length;
      };
      try { await register(); }
      catch {
        state.lifecycle.signal.throwIfAborted();
        pi.registerTool({
          name: `${COMPUTER_USE_TOOL_PREFIX}connect`, label: "Connect Computer Use",
          description: "Retry driver startup and register this platform's available computer-use tools.",
          parameters: Type.Object({}),
          async execute(_id, _args, signal) {
            try {
              const count = await register(signal);
              return { content: [{ type: "text", text: `Computer Use connected; registered ${count} platform tools.` }], details: { registered_tools: count } };
            } catch (failure) {
              signal?.throwIfAborted();
              state.lifecycle.signal.throwIfAborted();
              return { content: [{ type: "text", text: `Computer Use is still unavailable: ${failure instanceof Error ? failure.message : String(failure)}` }], details: undefined, isError: true };
            }
          },
        });
        pi.registerCommand("computer-use-connect", {
          description: "Retry Computer Use driver discovery",
          async handler(_args, ctx) {
            try { ctx.ui.notify(`Computer Use registered ${await register(ctx.signal)} platform tools.`, "info"); }
            catch { ctx.ui.notify("Computer Use driver is still unavailable.", "warning"); }
          },
        });
      }
      registerComputerUseVision(pi, state.config, (args, signal) => { state.lifecycle.signal.throwIfAborted(); return this.run(thread, `${COMPUTER_USE_TOOL_PREFIX}get_window_state`, args, signal); }, this.loadCompletion);
    };
  }

  remote(threadId: string, name: string, args: Record<string, unknown>) {
    if (!this.threads.has(threadId)) throw new Error("This thread's computer use is not running; open the thread to start it.");
    return this.run({ sessionId: threadId, cwd: "" }, name, args, AbortSignal.timeout(20_000), undefined, true);
  }

  async closeThread(threadId: string): Promise<void> {
    this.threads.get(threadId)?.lifecycle.abort(new Error("Computer Use thread closed."));
    this.threads.delete(threadId);
    this.feed.forget(threadId);
    await this.sessions.closeThread(threadId);
  }
  async close(): Promise<void> { for (const state of this.threads.values()) state.lifecycle.abort(new Error("Computer Use closed.")); this.threads.clear(); await this.sessions.close(); }
}

export async function loadComputerUseRuntime(context: HostExtensionContext, feed: ScreenFeed): Promise<ComputerUseRuntime> {
  const packageApi = await context.services.loadDependency(COMPUTER_USE_PACKAGE, { namespace: true }) as PackageApi;
  return new ComputerUseRuntime(packageApi, feed, (cwd) => context.services.projectTrust?.trusted(cwd) ?? false, () => context.services.loadDependency("@earendil-works/pi-ai/compat", { namespace: true }) as ReturnType<Parameters<typeof registerComputerUseVision>[3]>);
}
