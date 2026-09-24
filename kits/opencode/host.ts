import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_INSTANCE_ID,
  HostCommandError,
  RuntimeInstanceSettings,
  TurnActivityStore,
  commandInvocation,
  npmLatestVersion,
  packageInstallCommand,
  packageUpdateCommand,
  runtimeUpdateCommand,
  runtimeVersionPolicy,
  updateAvailable,
  versionCompatibility,
  type HostBackendThreadRecord,
  type HostExtension,
  type HostExtensionServices,
  type HostRuntimeBackendProvider,
  type RuntimeCompatibility,
  type RuntimeInstanceConfig,
  type RuntimeToolVersion,
  type VersionPolicy,
  THREAD_TEXTS_COMMAND,
  threadTextsDelta,
} from "tau/host-extension";
import { connectedProviders, openCodeNewThreadCatalog, parseModelRef, storedModels } from "./catalog.js";
import type { OpenCodeProviderList } from "./client.js";
import { importHome, importOpenCodeSessions, scanOpenCodeSessions } from "./history-import.js";
import { openCodeMcpConfig } from "./mcp.js";
import {
  INSTANCES_EVENT,
  MIN_OPENCODE_VERSION,
  ONBOARDING_KIT_ID,
  OPENCODE_BACKEND_KIND,
  OPENCODE_HOME_VARIABLE,
  OPENCODE_HOST_EXTENSION_ID,
  OPENCODE_NPM_PACKAGE,
  TESTED_OPENCODE_VERSION,
  SEARCH_KIT_ID,
  USAGE_KIT_ID,
  type OpenCodeInstancesReport,
  type OpenCodeStatusReport,
} from "./protocol.js";
import { createOpenCodeRuntimeAdapter } from "./runtime-adapter.js";
import { connectOpenCodeServer, startOpenCodeServer, type OpenCodeServeInput, type OpenCodeServerHandle } from "./server.js";
import { OpenCodeServerSettings } from "./server-settings.js";
import { OpenCodeSessionStore, type OpenCodeModelRef, type OpenCodeStoredModel } from "./session-store.js";
import { OpenCodeThreadRuntimeBackend, type OpenCodeConnectInput } from "./thread-backend.js";

export { OPENCODE_BACKEND_KIND, OPENCODE_HOST_EXTENSION_ID };

export const OPENCODE_COMMAND_VARIABLE = "TAU_OPENCODE_COMMAND";

export interface OpenCodeHostExtensionOptions {
  /** Starts a local server (tests start a fake one); the real one spawns `opencode serve`. */
  startServer?(input: OpenCodeServeInput & { instance: string }): Promise<OpenCodeServerHandle>;
  sessionsDir?: string;
  env?: NodeJS.ProcessEnv;
  /** `opencode --version`; tests answer it. */
  readVersion?(path: string): Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
}

/** What `status` and the catalog need of OpenCode, asked of a server that runs no thread. */
interface Probe { version?: string; providers: OpenCodeProviderList; configured?: OpenCodeModelRef; at: number }
const PROBE_TTL_MS = 10 * 60 * 1000;

/**
 * The releases this kit speaks to. Older servers lack routes Tau needs; the
 * release it was built against is the one to install.
 */
export const OPENCODE_VERSION_POLICY: VersionPolicy = {
  ranges: [{ range: `<${MIN_OPENCODE_VERSION}`, status: "broken", message: `Tau speaks the server API of OpenCode ${MIN_OPENCODE_VERSION} and newer; threads do not start on an older one.` }],
  recommendedVersion: TESTED_OPENCODE_VERSION,
};

/** OpenCode keeps everything under the XDG folders, so an instance's home becomes all four for its process. */
export function openCodeEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = env[OPENCODE_HOME_VARIABLE]?.trim();
  if (!home) return env;
  return { ...env, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache") };
}

export async function readOpenCodeVersion(path: string): Promise<string | undefined> {
  try {
    const invocation = commandInvocation(path, ["--version"]);
    const { stdout } = await promisify(execFile)(invocation.command, invocation.args, { timeout: 10_000, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments });
    return /\d+\.\d+\.\d+[^\s]*/u.exec(String(stdout))?.[0];
  } catch {
    return undefined;
  }
}

interface InstanceState {
  installed?: { path: string; version?: string };
  probe?: Promise<Probe>;
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
 * OpenCode as a runtime backend (ADR 0005): a thread drives `opencode serve`
 * over HTTP, one server per live thread that Tau starts, or a server the user
 * runs and names by URL and password. The providers and logins are
 * OpenCode's own. Each instance — the default one and any the user adds on
 * the Providers page — registers a backend of its own (`opencode`,
 * `opencode@<id>`), so a thread keeps the instance it started on.
 */
export function createOpenCodeHostExtension(options: OpenCodeHostExtensionOptions = {}): HostExtension {
  return {
    id: OPENCODE_HOST_EXTENSION_ID,
    name: "OpenCode",
    permissions: ["process", "sessions", "runtime:extend", "network"],
    activate(context) {
      const services: HostExtensionServices = context.services;
      const env = options.env ?? process.env;
      const storePath = OpenCodeSessionStore.defaultPath(options.sessionsDir ?? services.sessionsDir);
      const store = new OpenCodeSessionStore({ filePath: storePath });
      const activity = new TurnActivityStore({ directory: join(dirname(storePath), "opencode-activity") });
      const readVersion = options.readVersion ?? readOpenCodeVersion;
      const settings = new RuntimeInstanceSettings({
        file: join(services.stateDir, "settings.json"),
        driver: OPENCODE_BACKEND_KIND,
        label: "OpenCode",
        commandVariable: OPENCODE_COMMAND_VARIABLE,
        homeVariable: OPENCODE_HOME_VARIABLE,
        env,
      });
      const servers = new OpenCodeServerSettings(join(services.stateDir, "servers.json"));
      const policy = runtimeVersionPolicy(OPENCODE_BACKEND_KIND, OPENCODE_VERSION_POLICY, env);
      const states = new Map<string, InstanceState>();
      const state = (id: string): InstanceState => {
        let entry = states.get(id);
        if (!entry) states.set(id, entry = {});
        return entry;
      };
      const requireInstance = (id: string): RuntimeInstanceConfig => {
        const instance = settings.get(id);
        if (!instance) throw new HostCommandError(`OpenCode has no instance “${id}”.`);
        return instance;
      };

      const openCodeCommand = (id: string): string => settings.command(id).command;
      const instanceEnv = (id: string): NodeJS.ProcessEnv => openCodeEnvironment(settings.environment(id, env));
      const locate = (id: string): string | undefined => services.findCommand(openCodeCommand(id));
      const updateCommand = async (path: string | undefined): Promise<string> => {
        const real = path ? await realpath(path).catch(() => path) : undefined;
        return runtimeUpdateCommand(OPENCODE_BACKEND_KIND, (real && packageUpdateCommand(real, OPENCODE_NPM_PACKAGE)) ?? "opencode upgrade", env);
      };
      const compatibility = async (path: string | undefined, version: string | undefined): Promise<RuntimeCompatibility | undefined> => {
        const verdict = versionCompatibility(policy, version);
        if (!verdict?.recommendedVersion || !path) return verdict;
        const install = packageInstallCommand(await realpath(path).catch(() => path), OPENCODE_NPM_PACKAGE, verdict.recommendedVersion);
        return install ? { ...verdict, installCommand: install } : verdict;
      };
      const cli = async (id: string): Promise<{ path: string; version?: string }> => {
        const path = locate(id);
        if (!path) throw new Error(`The OpenCode CLI "${openCodeCommand(id)}" was not found on the PATH of your login shell. Install it (curl -fsSL https://opencode.ai/install | bash, or npm install -g ${OPENCODE_NPM_PACKAGE}), set its path under Settings → Providers, or connect to a running OpenCode server there.`);
        const entry = state(id);
        if (entry.installed?.path !== path) entry.installed = { path, ...(await readVersion(path).then((version) => version ? { version } : {})) };
        return entry.installed;
      };
      const refuseBroken = async (version: string | undefined, path?: string): Promise<void> => {
        const verdict = await compatibility(path, version);
        if (verdict?.status !== "broken") return;
        const fix = verdict.installCommand ? `Install ${verdict.recommendedVersion} with: ${verdict.installCommand}` : `Update it with: ${await updateCommand(path)}`;
        throw new Error(`OpenCode ${version ?? "(unknown version)"} does not work with Tau: ${verdict.message ?? ""} ${fix}`.replace(/\s+/gu, " ").trim());
      };

      /** The instance's server for a thread or a probe: the one it names, or a local one Tau starts. */
      const connect = async (id: string, input: OpenCodeConnectInput): Promise<OpenCodeServerHandle> => {
        const external = servers.get(id);
        if (external) {
          const server = await connectOpenCodeServer(external.url, external.password, options.fetch);
          await refuseBroken((await server.client.health()).version);
          return server;
        }
        const { path, version } = await cli(id);
        await refuseBroken(version, path);
        // A thread's server reaches Tau's tools; without the endpoint it still runs, only without them.
        const mcp = input.threadId
          ? await services.mcp.connect({ sessionId: input.threadId, cwd: input.cwd }, input.tools ? { tools: input.tools } : undefined).catch(() => undefined)
          : undefined;
        const serve: OpenCodeServeInput = {
          command: path,
          args: settings.args(id),
          cwd: input.cwd,
          env: instanceEnv(id),
          ...(mcp ? { config: openCodeMcpConfig(mcp) } : {}),
          onExit: input.onExit,
          onStderrLine: (line) => services.log("opencode.stderr", line.slice(0, 500)),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        };
        if (options.startServer) return options.startServer({ ...serve, instance: id });
        services.noteSubprocess();
        const server = await startOpenCodeServer(serve);
        services.log("opencode.session", `server for ${input.cwd} on instance ${id} at ${server.url}`);
        return server;
      };

      /** Providers, models and the configured model, from a server that runs no thread. */
      const runProbe = (id: string, fresh = false): Promise<Probe> => {
        const entry = state(id);
        if (!fresh && entry.probe) return entry.probe.then((cached) => Date.now() - cached.at < PROBE_TTL_MS ? cached : runProbe(id, true));
        const next = (async (): Promise<Probe> => {
          await mkdir(services.stateDir, { recursive: true });
          const directory = services.stateDir;
          const server = await connect(id, { cwd: directory, onExit: () => undefined });
          try {
            const [health, providers, config] = await Promise.all([
              server.client.health().catch(() => undefined),
              server.client.providers(directory),
              server.client.config(directory).catch(() => ({ model: undefined })),
            ]);
            const configured = parseModelRef(config.model);
            return { ...(health?.version ? { version: health.version } : {}), providers, ...(configured ? { configured } : {}), at: Date.now() };
          } finally {
            await server.close().catch(() => undefined);
          }
        })();
        entry.probe = next;
        next.catch(() => { if (entry.probe === next) entry.probe = undefined; });
        return next;
      };

      const cachedModels = async (id: string): Promise<OpenCodeStoredModel[]> => {
        const stored = await store.listModels(id);
        if (stored.length > 0) return stored;
        const models = storedModels((await runProbe(id)).providers);
        await store.setModels(models, id);
        return models;
      };

      const record = (entry: Awaited<ReturnType<OpenCodeSessionStore["list"]>>[number]): HostBackendThreadRecord => ({
        threadId: entry.tauThreadId,
        cwd: entry.cwd,
        ...(entry.title ? { title: entry.title } : {}),
        updatedAt: entry.updatedAt,
        messages: entry.messages,
      });

      const versionOf = async (id: string): Promise<RuntimeToolVersion | undefined> => {
        if (servers.get(id)) {
          const version = (await runProbe(id)).version;
          const verdict = await compatibility(undefined, version);
          return { tool: "opencode", ...(version ? { installed: version } : {}), updateCommand: "Update the OpenCode server you connect to.", ...(verdict ? { compatibility: verdict } : {}) };
        }
        const { path, version } = await cli(id);
        const latest = await npmLatestVersion(OPENCODE_NPM_PACKAGE, { cacheFile: join(services.stateDir, "latest-version.json"), ...(options.fetch ? { fetch: options.fetch } : {}) });
        const verdict = await compatibility(path, version);
        return {
          tool: "opencode",
          ...(version ? { installed: version } : {}),
          ...(latest ? { latest } : {}),
          updateCommand: await updateCommand(path),
          ...(verdict ? { compatibility: verdict } : {}),
        };
      };

      const providerFor = (id: string): HostRuntimeBackendProvider => {
        const kind = settings.kind(id);
        const adapter = createOpenCodeRuntimeAdapter(kind);
        return {
          kind,
          label: settings.label(id),
          order: 40,
          adapter,
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
          restrictsTools: true,
          open: async (threadId, cwd, { resume, tools }, thread) => {
            const backend = new OpenCodeThreadRuntimeBackend(threadId, cwd, {
              adapter,
              store,
              activity,
              instance: id,
              connect: (input) => connect(id, input),
              configuredModel: async () => (await state(id).probe?.catch(() => undefined))?.configured,
              storedModels: () => store.listModels(id),
              models: () => cachedModels(id),
              permissionLevel: thread.permissionLevel,
              ...(tools ? { tools } : {}),
              onMessage: thread.onMessage,
              onEvent: thread.onEvent,
              ask: thread.ask,
            });
            await backend.start(resume ? "resume" : "create");
            return backend;
          },
          composerCommands: () => [],
          version: () => versionOf(id),
          // The connected providers' models; the host keeps the answer and asks again now and then.
          newThreadCatalog: async () => {
            if (!servers.get(id) && !locate(id)) return { models: [], thinkingLevels: {}, status: "not-installed", note: `The OpenCode CLI "${openCodeCommand(id)}" is not installed.` };
            const probe = await runProbe(id);
            await store.setModels(storedModels(probe.providers), id).catch(() => undefined);
            return openCodeNewThreadCatalog(probe.providers, probe.configured);
          },
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

      const instancesReport = async (): Promise<OpenCodeInstancesReport> => {
        const threads = await store.list();
        return {
          instances: settings.list().map((instance) => {
            const server = servers.get(instance.id);
            return {
              ...instance,
              kind: settings.kind(instance.id),
              label: settings.label(instance.id),
              threads: threads.filter((entry) => (entry.instance ?? DEFAULT_INSTANCE_ID) === instance.id).length,
              ...(server ? { serverUrl: server.url, ...(server.password ? { hasPassword: true } : {}) } : {}),
            };
          }),
        };
      };
      const announce = async (): Promise<OpenCodeInstancesReport> => {
        const report = await instancesReport();
        context.emit(INSTANCES_EVENT, report);
        return report;
      };

      context.registerCommand("status", async (input): Promise<OpenCodeStatusReport> => {
        const id = instanceInput(input);
        requireInstance(id);
        const { command, source } = settings.command(id);
        const fresh = Boolean(input && typeof input === "object" && (input as { fresh?: unknown }).fresh);
        const external = servers.get(id);
        const base: OpenCodeStatusReport = { instance: id, command, ...(source ? { commandSource: source } : {}), ...(external ? { serverUrl: external.url } : {}) };
        let report: OpenCodeStatusReport = base;
        if (!external) {
          let found: { path: string; version?: string };
          try {
            if (fresh) state(id).installed = undefined;
            found = await cli(id);
          } catch (error) {
            return { ...base, message: errorText(error) };
          }
          const version = await versionOf(id).catch(() => undefined);
          report = {
            ...base,
            path: found.path,
            ...(found.version ? { version: found.version } : {}),
            ...(version?.latest ? { latest: version.latest } : {}),
            ...(version?.updateCommand ? { updateCommand: version.updateCommand } : {}),
            ...(updateAvailable(version) ? { updateAvailable: true } : {}),
            ...(version?.compatibility ? { compatibility: version.compatibility } : {}),
            ...(version?.compatibility?.status === "broken" ? { unsupported: true } : {}),
          };
          if (report.unsupported) return report;
        }
        try {
          const probed = await Promise.race([
            runProbe(id, fresh),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("OpenCode did not answer within 30 s.")), 30_000).unref?.()),
          ]);
          const providers = connectedProviders(probed.providers).map((provider) => ({ id: provider.id, name: provider.name ?? provider.id, models: Object.keys(provider.models).length }));
          const verdict = external ? await compatibility(undefined, probed.version) : report.compatibility;
          return {
            ...report,
            ...(external && probed.version ? { version: probed.version } : {}),
            ...(verdict ? { compatibility: verdict } : {}),
            ...(verdict?.status === "broken" ? { unsupported: true } : {}),
            providers,
            ...(providers.length ? { account: `${providers.slice(0, 2).map((provider) => provider.name).join(", ")}${providers.length > 2 ? ` +${providers.length - 2}` : ""}` } : {}),
            signedIn: providers.length > 0,
            models: providers.reduce((sum, provider) => sum + provider.models, 0),
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
          throw new HostCommandError(`${OPENCODE_COMMAND_VARIABLE} is set in Tau's environment and decides the path.`);
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
        await servers.remove(id);
        unregister(id);
        return announce();
      });
      context.registerCommand("set-command", async (input) => {
        const id = instanceInput(input);
        const current = requireInstance(id);
        const requested = typeof (input as { command?: unknown } | undefined)?.command === "string" ? (input as { command: string }).command.trim() : "";
        if (settings.command(id).source === "env") throw new HostCommandError(`${OPENCODE_COMMAND_VARIABLE} is set in Tau's environment and decides the path.`);
        if (requested && !services.findCommand(requested)) throw new HostCommandError(`No executable at "${requested}".`);
        const { command: _command, ...rest } = current;
        await settings.save({ ...rest, ...(requested ? { command: requested } : {}) });
        register(id);
        return { command: openCodeCommand(id) };
      });
      // A server the user runs instead of one Tau starts; an empty URL goes back to Tau's own.
      context.registerCommand("set-server", async (input) => {
        const id = instanceInput(input);
        requireInstance(id);
        const { url, password } = (input ?? {}) as { url?: unknown; password?: unknown };
        try {
          await servers.set(id, typeof url === "string" ? url : "", typeof password === "string" ? password : undefined);
        } catch (error) {
          throw new HostCommandError(errorText(error));
        }
        register(id);
        return announce();
      });
      context.registerCommand("recheck", async (input) => {
        const id = instanceInput(input);
        requireInstance(id);
        register(id);
        return versionOf(id).catch(() => undefined);
      });
      context.registerCommand("usage", async () => ({
        threads: (await store.list()).map((entry) => {
          const model = entry.model ?? entry.observedModel;
          return { threadId: entry.tauThreadId, cwd: entry.cwd, updatedAt: entry.updatedAt, ...(model ? { model: model.id } : {}), ...(entry.usage ? { usage: { ...entry.usage } } : {}) };
        }),
      }), { access: "read", callers: [USAGE_KIT_ID] });
      // What each thread said, for Search Kit to find threads nobody has open; only what it lacks.
      context.registerCommand(THREAD_TEXTS_COMMAND, async (input) => threadTextsDelta(await store.list(), input), { long: true, callers: [SEARCH_KIT_ID] });

      /** A server over the default instance's data, or the fixture home an import root names. */
      const importServer = async (): Promise<OpenCodeServerHandle> => {
        const home = importHome(env);
        if (!home) return connect(DEFAULT_INSTANCE_ID, { cwd: services.stateDir, onExit: () => undefined });
        const { path } = await cli(DEFAULT_INSTANCE_ID);
        const serve: OpenCodeServeInput = { command: path, cwd: services.stateDir, env: openCodeEnvironment({ ...env, [OPENCODE_HOME_VARIABLE]: home }), ...(options.fetch ? { fetch: options.fetch } : {}) };
        if (options.startServer) return options.startServer({ ...serve, instance: DEFAULT_INSTANCE_ID });
        services.noteSubprocess();
        return startOpenCodeServer(serve);
      };
      context.registerCommand("import-scan", async () => {
        // Without OpenCode there is nothing to import, which is no failure.
        if (!importHome(env) && !servers.get(DEFAULT_INSTANCE_ID) && !locate(DEFAULT_INSTANCE_ID)) return { source: OPENCODE_BACKEND_KIND, sessions: [], truncated: false };
        const held = await store.sessionIds();
        await mkdir(services.stateDir, { recursive: true });
        const server = await importServer();
        try {
          return { source: OPENCODE_BACKEND_KIND, ...await scanOpenCodeSessions(server.client, (id) => held.has(id)) };
        } finally {
          await server.close().catch(() => undefined);
        }
      }, { long: true, callers: [ONBOARDING_KIT_ID] });
      context.registerCommand("import-sessions", async (input) => {
        await mkdir(services.stateDir, { recursive: true });
        const server = await importServer();
        try {
          const outcome = await importOpenCodeSessions(server.client, (input as { paths?: unknown } | undefined)?.paths, store);
          return { ...outcome, ...(outcome.imported.length ? { update: await services.sessions.refreshIndex() } : {}) };
        } finally {
          await server.close().catch(() => undefined);
        }
      }, { long: true, callers: [ONBOARDING_KIT_ID] });

      for (const instance of settings.list()) register(instance.id);
      return () => { for (const id of [...states.keys()]) unregister(id); };
    },
  };
}

export default createOpenCodeHostExtension;
