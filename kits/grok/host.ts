import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_INSTANCE_ID,
  HostCommandError,
  RuntimeInstanceSettings,
  THREAD_TEXTS_COMMAND,
  TurnActivityStore,
  cliMaintenance,
  executableFingerprint,
  runtimeVersionPolicy,
  threadTextsDelta,
  versionCompatibility,
  type HostBackendThreadRecord,
  type HostExtension,
  type HostExtensionServices,
  type HostRuntimeBackendProvider,
  type HostRuntimeNewThreadCatalog,
  type RuntimeInstanceConfig,
  type RuntimeToolMaintenance,
  type RuntimeToolVersion,
  type UiModelBilling,
} from "tau/host-extension";
import type { AcpProcess, AcpSpawnInput } from "../_acp/client.js";
import { withTauServer } from "../_acp/mcp.js";
import type { AcpStoredModel } from "../_acp/session-store.js";
import { grokNewThreadCatalog, initializeModelState, modelName, storedModels } from "./catalog.js";
import { grokAgentArgs, grokEnvironment, readGrokModels, readGrokVersion, usesApiKey, type GrokModelsListing } from "./cli.js";
import { readGrokLimits, type GrokLimits } from "./limits.js";
import {
  GROK_BACKEND_KIND,
  GROK_HOME_VARIABLE,
  GROK_HOST_EXTENSION_ID,
  INSTANCES_EVENT,
  SEARCH_KIT_ID,
  USAGE_KIT_ID,
  type GrokInstancesReport,
  type GrokStatusReport,
} from "./protocol.js";
import { createGrokRuntimeAdapter } from "./runtime-adapter.js";
import { openGrokSession, probeGrok } from "./session.js";
import { GrokSessionStore } from "./session-store.js";
import { GrokThreadRuntimeBackend, grokUsageOrigin, type GrokSessionInput, type GrokSessionLike } from "./thread-backend.js";

export { GROK_BACKEND_KIND, GROK_HOST_EXTENSION_ID };

export const GROK_COMMAND_VARIABLE = "TAU_GROK_COMMAND";
const EXECUTABLE = "grok";
const PROBE_TTL_MS = 10 * 60 * 1000;
const LIMITS_TTL_MS = 5 * 60 * 1000;

export interface GrokHostExtensionOptions {
  /** Replaces the agent process (tests hand in a fake); the real one spawns `grok agent stdio`. */
  spawn?(input: AcpSpawnInput): AcpProcess;
  sessionsDir?: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
  readVersion?(path: string, env: NodeJS.ProcessEnv): Promise<string | undefined>;
  readModels?(path: string, env: NodeJS.ProcessEnv): Promise<GrokModelsListing>;
  fetch?: typeof globalThis.fetch;
}

interface Probe { listing: GrokModelsListing; models: AcpStoredModel[]; start?: string; at: number }
interface InstanceState {
  /** `key` is the executable's fingerprint: a replaced CLI is read again. */
  installed?: { path: string; version?: string; key?: string };
  probe?: Promise<Probe>;
  limits?: { at: number; value: GrokLimits };
  unregister?: () => void;
}

function instanceInput(input: unknown): string {
  const id = (input as { instance?: unknown } | undefined)?.instance;
  return typeof id === "string" && id ? id : DEFAULT_INSTANCE_ID;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Grok Build as a runtime backend (ADR 0005): a thread drives the Grok CLI's
 * ACP server (`grok agent stdio`), signed in with the CLI's own login or an
 * `XAI_API_KEY`. The protocol is `kits/_acp`, shared with Antigravity and
 * Cursor. Each instance registers a backend of its own (`grok`, `grok@<id>`).
 */
export function createGrokHostExtension(options: GrokHostExtensionOptions = {}): HostExtension {
  return {
    id: GROK_HOST_EXTENSION_ID,
    name: "Grok",
    permissions: ["process", "sessions", "runtime:extend", "network"],
    activate(context) {
      const services: HostExtensionServices = context.services;
      const env = options.env ?? process.env;
      const storePath = GrokSessionStore.defaultPath(options.sessionsDir ?? services.sessionsDir);
      const store = new GrokSessionStore({ filePath: storePath });
      const activity = new TurnActivityStore({ directory: join(dirname(storePath), "grok-activity") });
      const readVersion = options.readVersion ?? readGrokVersion;
      const readModels = options.readModels ?? readGrokModels;
      const settings = new RuntimeInstanceSettings({
        file: join(services.stateDir, "settings.json"),
        driver: GROK_BACKEND_KIND,
        label: "Grok",
        executable: EXECUTABLE,
        commandVariable: GROK_COMMAND_VARIABLE,
        homeVariable: GROK_HOME_VARIABLE,
        env,
      });
      // No release feed to compare with; a policy comes from TAU_VERSION_POLICY only.
      const policy = runtimeVersionPolicy(GROK_BACKEND_KIND, undefined, env);
      const states = new Map<string, InstanceState>();
      const state = (id: string): InstanceState => {
        let entry = states.get(id);
        if (!entry) states.set(id, entry = {});
        return entry;
      };
      const requireInstance = (id: string): RuntimeInstanceConfig => {
        const instance = settings.get(id);
        if (!instance) throw new HostCommandError(`Grok has no instance “${id}”.`);
        return instance;
      };

      const grokCommand = (id: string): string => settings.command(id).command;
      const instanceEnv = (id: string): NodeJS.ProcessEnv => grokEnvironment(settings.environment(id, env));
      const billing = (id: string): UiModelBilling => usesApiKey(instanceEnv(id)) ? "api-key" : "subscription";
      const locate = (id: string): string | undefined => services.findCommand(grokCommand(id));
      const cli = async (id: string): Promise<{ path: string; version?: string }> => {
        const path = locate(id);
        if (!path) throw new Error(`The Grok CLI "${grokCommand(id)}" was not found on the PATH of your login shell. Install Grok Build's CLI or set its path under Settings → Providers.`);
        const entry = state(id);
        const key = await executableFingerprint(path);
        if (entry.installed?.path !== path || entry.installed.key !== key) {
          if (entry.installed) entry.probe = undefined;
          entry.installed = { path, ...(key ? { key } : {}), ...(await readVersion(path, instanceEnv(id)).then((version) => version ? { version } : {})) };
        }
        return entry.installed;
      };
      const refuseBroken = ({ version }: { version?: string }): void => {
        const verdict = versionCompatibility(policy, version);
        if (verdict?.status === "broken") throw new Error(`Grok CLI ${version ?? "(unknown version)"} does not work with Tau${verdict.message ? `: ${verdict.message}` : "."}`);
      };

      const open = async (id: string, input: GrokSessionInput) => {
        const found = await cli(id);
        refuseBroken(found);
        const tau = await services.mcp.connect({ sessionId: input.threadId, cwd: input.cwd }).catch(() => undefined);
        if (!options.spawn) services.noteSubprocess();
        const session = await openGrokSession({
          command: found.path,
          args: [...settings.args(id), ...input.agentArgs],
          cwd: input.cwd,
          env: instanceEnv(id),
          clientVersion: options.clientVersion ?? "0.0.0",
          ...(options.spawn ? { spawn: options.spawn } : {}),
          mcpServers: withTauServer([], tau),
          onUpdate: input.onUpdate,
          onPermission: input.onPermission,
          onElicitation: input.onElicitation,
          onExit: input.onExit,
          onStderrLine: (line) => services.log("grok.stderr", line.slice(0, 500)),
        });
        services.log("grok.session", `thread ${input.threadId} on instance ${id} (${input.agentArgs.join(" ")})${tau ? " with Tau's tools" : ""}`);
        return session;
      };

      /** The login (`grok models`) and the models `initialize` names; neither signs in nor starts a session. */
      const runProbe = async (id: string, fresh = false): Promise<Probe> => {
        const entry = state(id);
        await cli(id).catch(() => undefined);
        if (!fresh && entry.probe) return entry.probe.then((cached) => Date.now() - cached.at < PROBE_TTL_MS ? cached : runProbe(id, true));
        const next = (async (): Promise<Probe> => {
          const { path } = await cli(id);
          const listing = await readModels(path, instanceEnv(id));
          if (listing.signedIn === false && !usesApiKey(instanceEnv(id))) return { listing, models: [], at: Date.now() };
          await mkdir(services.stateDir, { recursive: true });
          if (!options.spawn) services.noteSubprocess();
          const initialized = await probeGrok({ command: path, args: [...settings.args(id), ...grokAgentArgs("ask", true)], cwd: services.stateDir, env: instanceEnv(id), clientVersion: options.clientVersion ?? "0.0.0", ...(options.spawn ? { spawn: options.spawn } : {}) }).catch(() => undefined);
          const modelState = initializeModelState(initialized);
          const models = modelState ? storedModels(modelState) : listing.models.map((model) => ({ id: model.id, name: modelName(model.id), efforts: [] }));
          const start = modelState?.currentModelId ?? listing.models.find((model) => model.isDefault)?.id;
          return { listing, models, ...(start ? { start } : {}), at: Date.now() };
        })();
        entry.probe = next;
        next.catch(() => { if (entry.probe === next) entry.probe = undefined; });
        return next;
      };

      const record = (entry: Awaited<ReturnType<GrokSessionStore["list"]>>[number]): HostBackendThreadRecord => {
        const usage = store.talliesOf(entry.tauThreadId, grokUsageOrigin);
        return {
          threadId: entry.tauThreadId,
          cwd: entry.cwd,
          ...(entry.title ? { title: entry.title } : {}),
          ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
          updatedAt: entry.updatedAt,
          messages: entry.messages,
          ...(usage.length ? { usage } : {}),
        };
      };

      const versionOf = async (id: string): Promise<RuntimeToolVersion | undefined> => {
        const { version } = await cli(id);
        const verdict = versionCompatibility(policy, version);
        return { tool: "grok", ...(version ? { installed: version } : {}), ...(verdict ? { compatibility: verdict } : {}) };
      };

      const newThreadCatalog = async (id: string): Promise<HostRuntimeNewThreadCatalog> => {
        if (!locate(id)) return { models: [], thinkingLevels: {}, status: "not-installed", note: `The Grok CLI "${grokCommand(id)}" is not installed.` };
        try {
          refuseBroken(await cli(id));
        } catch (error) {
          return { models: [], thinkingLevels: {}, status: "unavailable", note: errorText(error) };
        }
        const probe = await runProbe(id);
        if (probe.listing.signedIn === false && !usesApiKey(instanceEnv(id))) {
          return { models: [], thinkingLevels: {}, status: "sign-in-required", note: "Grok is not signed in. Run grok login in a terminal, then open the picker again." };
        }
        await store.setModels(probe.models, id).catch(() => undefined);
        return grokNewThreadCatalog(probe.models, { billing: billing(id), ...(probe.start ? { start: probe.start } : {}) });
      };

      const providerFor = (id: string): HostRuntimeBackendProvider => {
        const kind = settings.kind(id);
        const adapter = createGrokRuntimeAdapter(kind);
        return {
          kind,
          label: settings.label(id),
          order: 60,
          adapter,
          homeProviders: ["xai"],
          listThreads: async () => (await store.list(id)).map(record),
          removeThread: async (threadId) => {
            const taken = await store.take(threadId);
            const tools = await activity.take(threadId);
            return taken && tools ? { ...taken, activity: tools } : taken;
          },
          restoreThread: async (threadId, value) => {
            await store.put(threadId, value);
            await activity.put(threadId, (value as { activity?: unknown } | undefined)?.activity);
          },
          lookup: async (threadId) => {
            const entry = await store.get(threadId);
            return entry && (entry.instance ?? DEFAULT_INSTANCE_ID) === id ? record(entry) : undefined;
          },
          open: async (threadId, cwd, { resume }, thread) => {
            const grokHome = instanceEnv(id).GROK_HOME;
            const backend = new GrokThreadRuntimeBackend(threadId, cwd, {
              adapter,
              store,
              activity,
              instance: id,
              openSession: (input) => open(id, input) as Promise<GrokSessionLike>,
              storedModels: () => store.listModels(id),
              billing: billing(id),
              ...(grokHome ? { grokHome } : {}),
              permissionLevel: thread.permissionLevel,
              ...(thread.executionPolicy ? { executionPolicy: thread.executionPolicy } : {}),
              onMessage: thread.onMessage,
              onEvent: thread.onEvent,
              ask: thread.ask,
              ...(thread.priceUsage ? { priceUsage: thread.priceUsage } : {}),
            });
            await backend.start(resume ? "resume" : "create");
            return backend;
          },
          composerCommands: () => [],
          version: () => versionOf(id),
          // Grok Build names no package or updater Tau knows; the Runtimes page says how it is installed.
          maintenance: async (): Promise<RuntimeToolMaintenance | undefined> => {
            if (!locate(id)) return undefined;
            const { path, version } = await cli(id);
            return cliMaintenance({ tool: "grok", path, ...(version ? { installed: version } : {}), spec: {}, findCommand: (name) => services.findCommand(name), cacheFile: join(services.stateDir, "package-versions.json"), env, home: homedir() });
          },
          programKey: () => executableFingerprint(locate(id)),
          newThreadCatalog: () => newThreadCatalog(id),
        };
      };

      const register = (id: string): void => {
        const entry = state(id);
        entry.unregister?.();
        entry.installed = undefined;
        entry.probe = undefined;
        entry.unregister = services.registerRuntimeBackend(providerFor(id));
      };
      const unregister = (id: string): void => {
        states.get(id)?.unregister?.();
        states.delete(id);
      };

      const instancesReport = async (): Promise<GrokInstancesReport> => {
        const threads = await store.list();
        return {
          instances: settings.list().map((instance) => ({
            ...instance,
            kind: settings.kind(instance.id),
            label: settings.label(instance.id),
            threads: threads.filter((entry) => (entry.instance ?? DEFAULT_INSTANCE_ID) === instance.id).length,
          })),
        };
      };
      const announce = async (): Promise<GrokInstancesReport> => {
        const report = await instancesReport();
        context.emit(INSTANCES_EVENT, report);
        return report;
      };

      context.registerCommand("status", async (input): Promise<GrokStatusReport> => {
        const id = instanceInput(input);
        requireInstance(id);
        const { command, source } = settings.command(id);
        const fresh = Boolean(input && typeof input === "object" && (input as { fresh?: unknown }).fresh);
        const apiKey = usesApiKey(instanceEnv(id));
        const base: GrokStatusReport = { instance: id, command, ...(source ? { commandSource: source } : {}), login: apiKey ? "api-key" : "account" };
        let found: { path: string; version?: string };
        try {
          if (fresh) state(id).installed = undefined;
          found = await cli(id);
        } catch (error) {
          return { ...base, message: errorText(error) };
        }
        const version = await versionOf(id).catch(() => undefined);
        const report: GrokStatusReport = { ...base, path: found.path, ...(found.version ? { version: found.version } : {}), ...(version?.compatibility ? { compatibility: version.compatibility } : {}) };
        try {
          const probe = await Promise.race([
            runProbe(id, fresh),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Grok did not answer within 30 s.")), 30_000).unref?.()),
          ]);
          const signedIn = apiKey ? true : probe.listing.signedIn;
          if (signedIn) await store.setModels(probe.models, id).catch(() => undefined);
          return {
            ...report,
            ...(signedIn !== undefined ? { signedIn } : {}),
            ...(apiKey ? { account: "XAI_API_KEY" } : probe.listing.account ? { account: probe.listing.account } : {}),
            ...(signedIn ? { models: probe.models.length } : {}),
          };
        } catch (error) {
          return { ...report, message: errorText(error) };
        }
      }, { access: "read" });
      context.registerCommand("instances", () => instancesReport(), { access: "read" });
      context.registerCommand("save-instance", async (input) => {
        const requested = (input as { instance?: unknown } | undefined)?.instance as RuntimeInstanceConfig | undefined;
        if (!requested || typeof requested.id !== "string") throw new HostCommandError("Name the instance to save.");
        if (requested.id === DEFAULT_INSTANCE_ID && requested.command !== settings.get(DEFAULT_INSTANCE_ID)?.command && settings.command(DEFAULT_INSTANCE_ID).source === "env") {
          throw new HostCommandError(`${GROK_COMMAND_VARIABLE} is set in Tau's environment and decides the path.`);
        }
        if (requested.command && !services.findCommand(requested.command)) throw new HostCommandError(`No executable at "${requested.command}".`);
        try {
          await settings.save(requested);
        } catch (error) {
          throw new HostCommandError(errorText(error));
        }
        register(requested.id);
        return announce();
      });
      context.registerCommand("remove-instance", async (input) => {
        const id = instanceInput(input);
        if (id === DEFAULT_INSTANCE_ID) throw new HostCommandError("The default instance cannot be removed.");
        await settings.remove(id);
        unregister(id);
        return announce();
      });
      context.registerCommand("set-command", async (input) => {
        const id = instanceInput(input);
        const current = requireInstance(id);
        const requested = typeof (input as { command?: unknown } | undefined)?.command === "string" ? (input as { command: string }).command.trim() : "";
        if (settings.command(id).source === "env") throw new HostCommandError(`${GROK_COMMAND_VARIABLE} is set in Tau's environment and decides the path.`);
        if (requested && !services.findCommand(requested)) throw new HostCommandError(`No executable at "${requested}".`);
        const { command: _command, ...rest } = current;
        await settings.save({ ...rest, ...(requested ? { command: requested } : {}) });
        register(id);
        return { command: grokCommand(id) };
      });
      context.registerCommand("recheck", async (input) => {
        const id = instanceInput(input);
        requireInstance(id);
        register(id);
        return versionOf(id).catch(() => undefined);
      });
      // Each thread's turns, for the Usage kit; read from the store, never from Grok.
      context.registerCommand("usage", async () => ({
        threads: (await store.list()).map((entry) => {
          const model = entry.model ?? entry.observedModel;
          return {
            threadId: entry.tauThreadId,
            cwd: entry.cwd,
            updatedAt: entry.updatedAt,
            ...(model ? { model } : {}),
            ...(entry.usage ? { usage: { ...entry.usage } } : {}),
            ...(entry.usageTurns ? { turns: entry.usageTurns.map((turn) => ({ ...turn })) } : {}),
          };
        }),
      }), { access: "read", callers: [USAGE_KIT_ID] });
      // The plan window of each signed-in instance; it reads the account and changes nothing.
      context.registerCommand("usage-limits", async (input) => {
        const refresh = Boolean(input && typeof input === "object" && (input as { refresh?: unknown }).refresh);
        const ids = settings.list().map((instance) => instance.id).filter((id) => locate(id));
        const accounts = await Promise.all(ids.map(async (id) => {
          const entry = state(id);
          if (refresh || !entry.limits || Date.now() - entry.limits.at >= LIMITS_TTL_MS) {
            entry.limits = { at: Date.now(), value: await readGrokLimits({ env: instanceEnv(id), ...(options.fetch ? { fetch: options.fetch } : {}) }) };
          }
          const { at, value } = entry.limits;
          return { id: `grok:${id}`, runtime: settings.kind(id), label: settings.label(id), checkedAt: at, windows: "windows" in value ? value.windows : [], ...("unavailable" in value ? { unavailable: value.unavailable } : {}) };
        }));
        return { accounts };
      }, { access: "read", long: true, callers: [USAGE_KIT_ID] });
      context.registerCommand(THREAD_TEXTS_COMMAND, async (input) => threadTextsDelta(await store.list(), input), { long: true, callers: [SEARCH_KIT_ID] });

      for (const instance of settings.list()) register(instance.id);
      return () => { for (const id of [...states.keys()]) unregister(id); };
    },
  };
}

export default createGrokHostExtension;
