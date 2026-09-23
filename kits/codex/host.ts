import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_INSTANCE_ID,
  HostCommandError,
  RuntimeInstanceSettings,
  commandInvocation,
  compareVersions,
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
  type HostRuntimeNewThreadCatalog,
  type RuntimeCompatibility,
  type RuntimeInstanceConfig,
  type RuntimeToolVersion,
  type VersionPolicy,
} from "tau/host-extension";
import { CodexAppServer, type CodexAccount, type CodexModel } from "./app-server.js";
import { codexHome, readCodexConfiguredModel } from "./config.js";
import { codexSessionDirs, importCodexSessions, scanCodexSessions } from "./history-import.js";
import { codexMcpLaunch } from "./mcp.js";
import { codexToolArgs } from "./tools.js";
import {
  CODEX_BACKEND_KIND,
  CODEX_HOME_VARIABLE,
  CODEX_HOST_EXTENSION_ID,
  CODEX_NPM_PACKAGE,
  INSTANCES_EVENT,
  MIN_CODEX_VERSION,
  ONBOARDING_KIT_ID,
  USAGE_KIT_ID,
  type CodexInstancesReport,
  type CodexStatusReport,
} from "./protocol.js";
import { createCodexRuntimeAdapter } from "./runtime-adapter.js";
import { CodexSessionStore, type CodexStoredModel } from "./session-store.js";
import { CodexThreadRuntimeBackend, MODEL_PROVIDER, storedModel, type CodexSessionInput, type CodexSessionLike } from "./thread-backend.js";

export { CODEX_BACKEND_KIND, CODEX_HOST_EXTENSION_ID };

export interface CodexHostExtensionOptions {
  /** Opens a session (tests script one); the real one spawns `codex app-server`. */
  openSession?(input: CodexSessionInput & { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; instance: string }): Promise<CodexSessionLike>;
  sessionsDir?: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
  /** `codex --version`; tests answer it. */
  readVersion?(path: string): Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
}

/** What `status` and the model list need of the CLI, asked without a thread. */
interface Probe { account?: CodexAccount; models: CodexModel[]; codexHome?: string; at: number }
const PROBE_TTL_MS = 10 * 60 * 1000;

export const CODEX_COMMAND_VARIABLE = "TAU_CODEX_COMMAND";

/**
 * The releases this kit speaks to. The app-server protocol is experimental and
 * moves between releases: an older CLI is broken, and the release the kit was
 * built against is the one to install. `TAU_VERSION_POLICY` may replace it.
 */
export const CODEX_VERSION_POLICY: VersionPolicy = {
  ranges: [{ range: `<${MIN_CODEX_VERSION}`, status: "broken", message: `Tau speaks the app-server protocol of Codex ${MIN_CODEX_VERSION} and newer; threads do not start on an older one.` }],
  recommendedVersion: MIN_CODEX_VERSION,
};

/** The models a new thread may start on, with the effort each offers; the first entry is Codex's own default. */
export function codexNewThreadCatalog(models: readonly CodexStoredModel[], configured: { model?: string; effort?: string }): HostRuntimeNewThreadCatalog {
  const start = (configured.model ? models.find((model) => model.id === configured.model) : undefined) ?? models.find((model) => model.isDefault) ?? models[0];
  return {
    models: models.map((model) => ({ provider: MODEL_PROVIDER, id: model.id, name: model.name })),
    ...(start ? { model: { provider: MODEL_PROVIDER, id: start.id, name: start.name } } : {}),
    thinkingLevels: Object.fromEntries(models.map((model) => {
      const applied = configured.effort ?? model.defaultEffort;
      return [model.id, [applied ? `default (${applied})` : "default", ...model.efforts]];
    })),
  };
}

export async function readCodexVersion(path: string): Promise<string | undefined> {
  try {
    const invocation = commandInvocation(path, ["--version"]);
    const { stdout } = await promisify(execFile)(invocation.command, invocation.args, { timeout: 10_000, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments });
    return /\d+\.\d+\.\d+[^\s]*/u.exec(String(stdout))?.[0];
  } catch {
    return undefined;
  }
}

function accountSummary(account: CodexAccount | undefined): CodexStatusReport["account"] {
  if (!account) return undefined;
  if (account.type === "chatgpt") {
    const chatgpt = account as { planType?: string; email?: string | null };
    return { kind: "chatgpt", ...(chatgpt.planType ? { plan: chatgpt.planType } : {}), ...(chatgpt.email ? { email: chatgpt.email } : {}) };
  }
  return { kind: account.type === "apiKey" ? "apiKey" : "other" };
}

/** Per instance: its CLI as last found, its probe, and the backend it registered. */
interface InstanceState {
  installed?: { path: string; version?: string };
  probe?: Promise<Probe>;
  unregister?: () => void;
}

function instanceInput(input: unknown): string {
  const id = (input as { instance?: unknown } | undefined)?.instance;
  return typeof id === "string" && id ? id : DEFAULT_INSTANCE_ID;
}

/**
 * OpenAI's Codex CLI as a runtime backend (ADR 0005): threads of this kind
 * drive the installed `codex` through `codex app-server` and persist in Tau's
 * app data. The login is the CLI's own. Each instance — the default one and
 * any the user adds on the Providers page, with its own executable, home
 * (`CODEX_HOME`), environment and arguments — registers a backend of its own
 * (`codex`, `codex@<id>`), so a thread keeps the instance it started on.
 */
export function createCodexHostExtension(options: CodexHostExtensionOptions = {}): HostExtension {
  return {
    id: CODEX_HOST_EXTENSION_ID,
    name: "Codex",
    permissions: ["process", "sessions", "runtime:extend", "network"],
    activate(context) {
      const services: HostExtensionServices = context.services;
      const env = options.env ?? process.env;
      const store = new CodexSessionStore({ filePath: CodexSessionStore.defaultPath(options.sessionsDir ?? services.sessionsDir) });
      const readVersion = options.readVersion ?? readCodexVersion;
      const settings = new RuntimeInstanceSettings({
        file: join(services.stateDir, "settings.json"),
        driver: CODEX_BACKEND_KIND,
        label: "Codex",
        commandVariable: CODEX_COMMAND_VARIABLE,
        homeVariable: CODEX_HOME_VARIABLE,
        env,
      });
      const policy = runtimeVersionPolicy(CODEX_BACKEND_KIND, CODEX_VERSION_POLICY, env);
      const states = new Map<string, InstanceState>();
      const state = (id: string): InstanceState => {
        let entry = states.get(id);
        if (!entry) states.set(id, entry = {});
        return entry;
      };
      const requireInstance = (id: string): RuntimeInstanceConfig => {
        const instance = settings.get(id);
        if (!instance) throw new HostCommandError(`Codex has no instance “${id}”.`);
        return instance;
      };

      const codexCommand = (id: string): string => settings.command(id).command;
      const instanceEnv = (id: string): NodeJS.ProcessEnv => settings.environment(id, env);
      const locate = (id: string): string | undefined => services.findCommand(codexCommand(id));
      const updateCommand = async (path: string | undefined): Promise<string> => {
        const real = path ? await realpath(path).catch(() => path) : undefined;
        return runtimeUpdateCommand(CODEX_BACKEND_KIND, (real && packageUpdateCommand(real, CODEX_NPM_PACKAGE)) ?? "codex update", env);
      };
      const compatibility = async (path: string, version: string | undefined): Promise<RuntimeCompatibility | undefined> => {
        const verdict = versionCompatibility(policy, version);
        if (!verdict?.recommendedVersion) return verdict;
        // A package manager that cannot pin a release (Homebrew) leaves the update command.
        const install = packageInstallCommand(await realpath(path).catch(() => path), CODEX_NPM_PACKAGE, verdict.recommendedVersion);
        return install ? { ...verdict, installCommand: install } : verdict;
      };
      /** The instance's CLI and its version; read once per path. */
      const cli = async (id: string): Promise<{ path: string; version?: string }> => {
        const path = locate(id);
        if (!path) throw new Error(`The Codex CLI "${codexCommand(id)}" was not found on the PATH of your login shell. Install it (brew install --cask codex, or npm install -g ${CODEX_NPM_PACKAGE}) or set its path under Settings → Providers.`);
        const entry = state(id);
        if (entry.installed?.path !== path) entry.installed = { path, ...(await readVersion(path).then((version) => version ? { version } : {})) };
        return entry.installed;
      };
      const assertSupported = async (id: string): Promise<string> => {
        const { path, version } = await cli(id);
        const verdict = await compatibility(path, version);
        if (verdict?.status !== "broken") return path;
        const older = version !== undefined && compareVersions(version, MIN_CODEX_VERSION) < 0;
        const reason = older ? `Codex ${version} is older than ${MIN_CODEX_VERSION}, the oldest release Tau speaks to.` : `Codex ${version} does not work with Tau.`;
        const fix = verdict.installCommand ? `Install ${verdict.recommendedVersion} with: ${verdict.installCommand}` : `Update it with: ${await updateCommand(path)}`;
        throw new Error(`${reason} ${fix}`);
      };

      const spawnSession = async (id: string, input: CodexSessionInput): Promise<CodexSessionLike> => {
        const command = await assertSupported(id);
        // A thread's session reaches Tau's tools; without the endpoint it still runs, only without them.
        const mcp = input.threadId
          ? await services.mcp.connect({ sessionId: input.threadId, cwd: input.cwd }, input.tools ? { tools: input.tools } : undefined).catch(() => undefined)
          : undefined;
        const tau = mcp ? codexMcpLaunch(mcp) : { args: [], env: {} };
        const launch = { args: [...tau.args, ...(input.tools ? codexToolArgs(input.tools) : []), ...settings.args(id)], env: tau.env };
        const sessionEnv = { ...instanceEnv(id), ...launch.env };
        if (options.openSession) return options.openSession({ ...input, command, args: launch.args, env: sessionEnv, instance: id });
        services.noteSubprocess();
        const server = await CodexAppServer.open({
          command,
          args: launch.args,
          cwd: input.cwd,
          env: sessionEnv,
          clientVersion: options.clientVersion ?? "0.0.0",
          onNotification: input.onNotification,
          onRequest: input.onRequest,
          onExit: input.onExit,
          onStderrLine: (line) => services.log("codex.stderr", line.slice(0, 500)),
        });
        services.log("codex.session", `app-server for ${input.cwd} on instance ${id}, home ${server.codexHome ?? "unknown"}`);
        return server;
      };

      /** Account and models, from a short-lived app-server that starts no thread. */
      const runProbe = (id: string, fresh = false): Promise<Probe> => {
        const entry = state(id);
        if (!fresh && entry.probe) return entry.probe.then((cached) => Date.now() - cached.at < PROBE_TTL_MS ? cached : runProbe(id, true));
        const next = (async (): Promise<Probe> => {
          await mkdir(services.stateDir, { recursive: true });
          const session = await spawnSession(id, {
            cwd: services.stateDir,
            onNotification: () => undefined,
            onRequest: async () => { throw new Error("No thread runs in a probe."); },
            onExit: () => undefined,
          });
          try {
            const [account, models] = await Promise.all([session.account?.(), session.models()]);
            return { ...(account ? { account } : {}), models, ...(session.codexHome ? { codexHome: session.codexHome } : {}), at: Date.now() };
          } finally {
            await session.close().catch(() => undefined);
          }
        })();
        entry.probe = next;
        next.catch(() => { if (entry.probe === next) entry.probe = undefined; });
        return next;
      };

      const cachedModels = async (id: string): Promise<CodexStoredModel[]> => {
        const stored = await store.listModels(id);
        if (stored.length > 0) return stored;
        const models = (await runProbe(id)).models.map(storedModel);
        await store.setModels(models, id);
        return models;
      };

      const record = (entry: Awaited<ReturnType<CodexSessionStore["list"]>>[number]): HostBackendThreadRecord => ({
        threadId: entry.tauThreadId,
        cwd: entry.cwd,
        ...(entry.title ? { title: entry.title } : {}),
        updatedAt: entry.updatedAt,
        messages: entry.messages,
      });

      const versionOf = async (id: string): Promise<RuntimeToolVersion | undefined> => {
        const { path, version } = await cli(id);
        const latest = await npmLatestVersion(CODEX_NPM_PACKAGE, { cacheFile: join(services.stateDir, "latest-version.json"), ...(options.fetch ? { fetch: options.fetch } : {}) });
        const verdict = await compatibility(path, version);
        return {
          tool: "codex",
          ...(version ? { installed: version } : {}),
          ...(latest ? { latest } : {}),
          updateCommand: await updateCommand(path),
          ...(verdict ? { compatibility: verdict } : {}),
        };
      };

      const providerFor = (id: string): HostRuntimeBackendProvider => {
        const kind = settings.kind(id);
        const adapter = createCodexRuntimeAdapter(kind);
        const home = (): string => codexHome(instanceEnv(id));
        return {
          kind,
          label: settings.label(id),
          order: 20,
          adapter,
          modelProvider: "openai",
          listThreads: async () => (await store.list(id)).map(record),
          removeThread: (threadId) => store.take(threadId),
          restoreThread: (threadId, value) => store.put(threadId, value),
          lookup: async (threadId) => {
            const entry = await store.get(threadId);
            return entry && (entry.instance ?? DEFAULT_INSTANCE_ID) === id ? record(entry) : undefined;
          },
          restrictsTools: true,
          open: async (threadId, cwd, { resume, tools }, thread) => {
            await assertSupported(id);
            const backend = new CodexThreadRuntimeBackend(threadId, cwd, {
              adapter,
              store,
              instance: id,
              configuredModel: () => readCodexConfiguredModel(home()),
              openSession: (input) => spawnSession(id, input),
              storedModels: () => store.listModels(id),
              models: () => cachedModels(id),
              onModels: (models) => void store.setModels(models, id).catch(() => undefined),
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
          // A draft on this instance chooses from the account's models, starting where config.toml points.
          newThreadCatalog: async () => codexNewThreadCatalog(await cachedModels(id), await readCodexConfiguredModel(home())),
        };
      };

      /** Registers the instance's backend anew, so core asks its version again and republishes. */
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

      const instancesReport = async (): Promise<CodexInstancesReport> => {
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
      const announce = async (): Promise<CodexInstancesReport> => {
        const report = await instancesReport();
        context.emit(INSTANCES_EVENT, report);
        return report;
      };

      context.registerCommand("status", async (input): Promise<CodexStatusReport> => {
        const id = instanceInput(input);
        requireInstance(id);
        const { command, source } = settings.command(id);
        const fresh = Boolean(input && typeof input === "object" && (input as { fresh?: unknown }).fresh);
        const base = { instance: id, command, ...(source ? { commandSource: source } : {}) };
        let found: { path: string; version?: string };
        try {
          if (fresh) state(id).installed = undefined;
          found = await cli(id);
        } catch (error) {
          return { ...base, message: error instanceof Error ? error.message : String(error) };
        }
        const version = await versionOf(id).catch(() => undefined);
        const report: CodexStatusReport = {
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
        try {
          const probed = await Promise.race([
            runProbe(id, fresh),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Codex did not report its account within 20 s.")), 20_000).unref?.()),
          ]);
          const account = accountSummary(probed.account);
          return { ...report, ...(account ? { account } : {}), signedIn: account !== undefined, models: probed.models.length, ...(probed.codexHome ? { codexHome: probed.codexHome } : {}) };
        } catch (error) {
          return { ...report, message: error instanceof Error ? error.message : String(error) };
        }
      });
      context.registerCommand("instances", () => instancesReport());
      // Adds or edits an instance from the Providers page; its backend is registered anew.
      context.registerCommand("save-instance", async (input) => {
        const requested = (input as { instance?: unknown } | undefined)?.instance as RuntimeInstanceConfig | undefined;
        if (!requested || typeof requested.id !== "string") throw new HostCommandError("Name the instance to save.");
        if (requested.id === DEFAULT_INSTANCE_ID && requested.command !== settings.get(DEFAULT_INSTANCE_ID)?.command && settings.command(DEFAULT_INSTANCE_ID).source === "env") {
          throw new HostCommandError(`${CODEX_COMMAND_VARIABLE} is set in Tau's environment and decides the path.`);
        }
        if (requested.command && !services.findCommand(requested.command)) throw new HostCommandError(`No executable at "${requested.command}".`);
        try {
          await settings.save(requested);
        } catch (error) {
          throw new HostCommandError(error instanceof Error ? error.message : String(error));
        }
        register(requested.id);
        return announce();
      });
      // Forgets an instance; its threads stay in the store and come back with an instance of the same id.
      context.registerCommand("remove-instance", async (input) => {
        const id = instanceInput(input);
        if (id === DEFAULT_INSTANCE_ID) throw new HostCommandError("The default instance cannot be removed.");
        await settings.remove(id);
        unregister(id);
        return announce();
      });
      // The executable's path from the Providers card; empty clears it.
      context.registerCommand("set-command", async (input) => {
        const id = instanceInput(input);
        const current = requireInstance(id);
        const requested = typeof (input as { command?: unknown } | undefined)?.command === "string" ? (input as { command: string }).command.trim() : "";
        if (settings.command(id).source === "env") throw new HostCommandError(`${CODEX_COMMAND_VARIABLE} is set in Tau's environment and decides the path.`);
        if (requested && !services.findCommand(requested)) throw new HostCommandError(`No executable at "${requested}".`);
        const { command: _command, ...rest } = current;
        await settings.save({ ...rest, ...(requested ? { command: requested } : {}) });
        register(id);
        return { command: codexCommand(id) };
      });
      // After the user ran the update command: the CLI is read again, and core asks its version anew.
      context.registerCommand("recheck", async (input) => {
        const id = instanceInput(input);
        requireInstance(id);
        register(id);
        return versionOf(id).catch(() => undefined);
      });
      // Each thread's running total, for the Usage kit; read from the store, never from OpenAI.
      context.registerCommand("usage", async () => ({
        threads: (await store.list()).map((entry) => {
          const model = entry.model ?? entry.observedModel;
          return { threadId: entry.tauThreadId, cwd: entry.cwd, updatedAt: entry.updatedAt, ...(model ? { model } : {}), ...(entry.usage ? { usage: { ...entry.usage } } : {}) };
        }),
      }), { callers: [USAGE_KIT_ID] });
      // Sessions the default instance's CLI ran on its own, for Onboarding to list and import as threads.
      context.registerCommand("import-scan", async () => {
        const held = await store.codexThreadIds();
        return { source: CODEX_BACKEND_KIND, ...await scanCodexSessions(codexSessionDirs(instanceEnv(DEFAULT_INSTANCE_ID)), (id) => held.has(id)) };
      }, { long: true, callers: [ONBOARDING_KIT_ID] });
      context.registerCommand("import-sessions", async (input) => {
        const outcome = await importCodexSessions(codexSessionDirs(instanceEnv(DEFAULT_INSTANCE_ID)), (input as { paths?: unknown } | undefined)?.paths, store);
        return { ...outcome, ...(outcome.imported.length ? { update: await services.sessions.refreshIndex() } : {}) };
      }, { long: true, callers: [ONBOARDING_KIT_ID] });

      for (const instance of settings.list()) register(instance.id);
      return () => { for (const id of [...states.keys()]) unregister(id); };
    },
  };
}

export default createCodexHostExtension;
