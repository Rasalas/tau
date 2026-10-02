import { randomUUID } from "node:crypto";
import {
  SIGN_IN_COMMANDS,
  SIGN_IN_EVENT,
  signInActive,
  type SignInEvent,
  type SignInFlowState,
  type SignInPrompt,
  type SignInReport,
} from "../shared/sign-in.js";
import { HostCommandError } from "./host-extension-errors.js";
import type { HostExtensionCommandHandler, HostExtensionCommandOptions } from "./host-extensions.js";

/** What a flow shows while it waits: a page, a code, a command, a line. */
export type SignInShown = Partial<Pick<SignInFlowState, "browser" | "deviceCode" | "terminal" | "message" | "links">>;

/** The running flow as the kit's own code sees it. */
export interface SignInFlowContext {
  readonly flowId: string;
  readonly target: string;
  /** Aborts when the user cancels, the flow times out or another one replaces it. */
  readonly signal: AbortSignal;
  /** Replaces what the window shows; the flow is waiting on the user from here on. */
  show(shown: SignInShown): void;
  /** Asks the user and waits; rejects when the flow ends first, or when `signal` says the answer is no longer needed. */
  ask(prompt: Omit<SignInPrompt, "id">, options?: { signal?: AbortSignal }): Promise<string>;
  /** The program has what it needs and is being asked whether it worked. */
  verifying(message?: string): void;
}

export interface SignInOptions {
  /** Methods and account of one target, without the flow; asked for `sign-in-state` and after a flow ends. */
  report(target: string): Promise<Omit<SignInReport, "flow">>;
  /** Runs one method; resolves once the program is signed in, with the line to show, and rejects with the reason it is not. */
  signIn(target: string, method: string, flow: SignInFlowContext): Promise<string | void>;
  signOut(target: string): Promise<string | void>;
  /** After a sign-in or a sign-out: the kit asks its program again (re-registers its backend, drops a probe). */
  changed?(target: string): void | Promise<void>;
  /** The target a command without one means. */
  defaultTarget?: string;
  /** A flow nobody finished gives up after this long; ten minutes by default. */
  timeoutMs?: number;
  /** Other host extensions allowed to run the commands (Onboarding asks through the window, which needs none). */
  callers?: readonly string[];
  now?(): number;
}

interface RegisteringContext {
  registerCommand(name: string, handler: HostExtensionCommandHandler, options?: HostExtensionCommandOptions): () => void;
  emit(name: string, payload?: unknown): void;
}

interface Flow {
  state: SignInFlowState;
  controller: AbortController;
  prompt?: { id: string; resolve(value: string): void; reject(error: Error): void };
  timer?: ReturnType<typeof setTimeout>;
  prompts: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

function field(input: unknown, name: string): string | undefined {
  const value = (input as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The five sign-in commands and the `sign-in` event (`src/shared/sign-in.ts`)
 * around a kit's own flows: one flow per target at a time, each with an id the
 * window must name, a timeout, cancel, and the prompts it waits on. The kit
 * only says what its program offers and how each method runs.
 */
export function registerSignIn(context: RegisteringContext, options: SignInOptions): { dispose(): void; publish(target?: string): Promise<void> } {
  const flows = new Map<string, Flow>();
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const targetOf = (input: unknown): string => field(input, "target") ?? options.defaultTarget ?? "default";
  let disposed = false;
  const emit = (event: SignInEvent) => { if (!disposed) context.emit(SIGN_IN_EVENT, event); };
  const publish = (target: string, flow: Flow) => emit({ target, flow: flow.state });

  const update = (target: string, flow: Flow, patch: Partial<SignInFlowState>) => {
    if (flows.get(target) !== flow || !signInActive(flow.state)) return;
    flow.state = { ...flow.state, ...patch };
    publish(target, flow);
  };

  const report = async (target: string): Promise<SignInReport> => {
    const flow = flows.get(target)?.state;
    return { ...await options.report(target), ...(flow ? { flow } : {}) };
  };

  /** Ends a flow once; what follows it (the kit's recheck, the report) never runs for a flow already ended. */
  const finish = async (target: string, flow: Flow, phase: "succeeded" | "failed" | "cancelled", line?: string) => {
    if (!signInActive(flow.state)) return;
    if (flow.timer) clearTimeout(flow.timer);
    const { prompt: _prompt, browser: _browser, deviceCode: _code, terminal: _terminal, ...rest } = flow.state;
    flow.state = { ...rest, phase, ...(line ? { message: line } : {}) };
    flow.prompt?.reject(new Error("The sign-in ended."));
    flow.prompt = undefined;
    if (!flow.controller.signal.aborted) flow.controller.abort();
    if (flows.get(target) !== flow) return;
    publish(target, flow);
    if (phase === "succeeded") await Promise.resolve(options.changed?.(target)).catch(() => undefined);
    emit({ target, report: await report(target).catch((error: unknown) => ({ methods: [], flow: { ...flow.state, message: message(error) } })) });
  };

  const start = async (target: string, method: string): Promise<SignInFlowState> => {
    const offered = (await options.report(target)).methods.find((entry) => entry.id === method);
    if (!offered) throw new HostCommandError(`There is no sign-in method “${method}”.`);
    if (offered.unavailable) throw new HostCommandError(offered.unavailable);
    const previous = flows.get(target);
    if (previous && signInActive(previous.state)) await finish(target, previous, "cancelled", "Another sign-in started.");
    const flow: Flow = {
      state: { flowId: randomUUID(), method, phase: "starting", expiresAt: now() + timeoutMs },
      controller: new AbortController(),
      prompts: 0,
    };
    flows.set(target, flow);
    flow.timer = setTimeout(() => void finish(target, flow, "failed", "The sign-in took too long. Start it again."), timeoutMs);
    flow.timer.unref?.();
    const flowContext: SignInFlowContext = {
      flowId: flow.state.flowId,
      target,
      signal: flow.controller.signal,
      show: (shown) => update(target, flow, { ...shown, phase: "waiting" }),
      verifying: (line) => update(target, flow, { phase: "verifying", ...(line ? { message: line } : {}) }),
      ask: (prompt, askOptions) => new Promise<string>((resolve, reject) => {
        if (!signInActive(flow.state)) { reject(new Error("The sign-in ended.")); return; }
        flow.prompt?.reject(new Error("Another question replaced this one."));
        const id = `p${++flow.prompts}`;
        flow.prompt = { id, resolve, reject };
        update(target, flow, { prompt: { ...prompt, id }, phase: "waiting" });
        askOptions?.signal?.addEventListener("abort", () => {
          if (flow.prompt?.id !== id) return;
          flow.prompt = undefined;
          const { prompt: _asked, ...rest } = flow.state;
          if (flows.get(target) === flow && signInActive(flow.state)) { flow.state = rest; publish(target, flow); }
          reject(new Error("The question is no longer needed."));
        }, { once: true });
      }),
    };
    void options.signIn(target, method, flowContext).then(
      (line) => finish(target, flow, "succeeded", line || undefined),
      (error: unknown) => finish(target, flow, flow.controller.signal.aborted ? "cancelled" : "failed", message(error)),
    );
    return flow.state;
  };

  const running = (target: string, input: unknown): Flow => {
    const flow = flows.get(target);
    if (!flow || flow.state.flowId !== field(input, "flowId") || !signInActive(flow.state)) throw new HostCommandError("This sign-in is no longer running. Start it again.");
    return flow;
  };

  const stops = [
    context.registerCommand(SIGN_IN_COMMANDS.state, (input) => report(targetOf(input)), options.callers ? { callers: options.callers } : undefined),
    context.registerCommand(SIGN_IN_COMMANDS.start, async (input) => {
      const method = field(input, "method");
      if (!method) throw new HostCommandError("Name the sign-in method.");
      return start(targetOf(input), method);
    }, options.callers ? { callers: options.callers } : undefined),
    context.registerCommand(SIGN_IN_COMMANDS.respond, (input) => {
      const target = targetOf(input);
      const flow = running(target, input);
      const value = (input as { value?: unknown } | undefined)?.value;
      if (!flow.prompt || typeof value !== "string") throw new HostCommandError("The sign-in is not waiting for an answer.");
      const pending = flow.prompt;
      flow.prompt = undefined;
      const { prompt: _prompt, ...rest } = flow.state;
      flow.state = rest;
      publish(target, flow);
      pending.resolve(value);
      return flow.state;
    }, options.callers ? { callers: options.callers } : undefined),
    context.registerCommand(SIGN_IN_COMMANDS.cancel, async (input) => {
      const target = targetOf(input);
      const flow = flows.get(target);
      if (flow && flow.state.flowId === field(input, "flowId")) await finish(target, flow, "cancelled", "Sign-in cancelled.");
      return flows.get(target)?.state;
    }, options.callers ? { callers: options.callers } : undefined),
    context.registerCommand(SIGN_IN_COMMANDS.signOut, async (input) => {
      const target = targetOf(input);
      const flow = flows.get(target);
      if (flow && signInActive(flow.state)) await finish(target, flow, "cancelled");
      flows.delete(target);
      let line: string | void;
      try {
        line = await options.signOut(target);
      } catch (error) {
        throw new HostCommandError(message(error));
      }
      await Promise.resolve(options.changed?.(target)).catch(() => undefined);
      const next = await report(target);
      emit({ target, report: next });
      return { ...next, ...(line ? { note: line } : {}) };
    }, { long: true, ...(options.callers ? { callers: options.callers } : {}) }),
  ];

  return {
    // What a target offers changed outside a flow (a setting the kit keeps); every window that may sign in hears it.
    publish: async (target = options.defaultTarget ?? "default") => { emit({ target, report: await report(target) }); },
    dispose: () => {
      disposed = true;
      for (const stop of stops) stop();
      for (const [target, flow] of flows) void finish(target, flow, "cancelled");
      flows.clear();
    },
  };
}
