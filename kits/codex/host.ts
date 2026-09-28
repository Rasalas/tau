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
  commandLine,
  compareVersions,
  npmLatestVersion,
  packageInstallCommand,
  packageUpdateCommand,
  registerSignIn,
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
  type SignInAccount,
  type SignInMethod,
  type UiModel,
  type UiModelBilling,
  type VersionPolicy,
  THREAD_TEXTS_COMMAND,
  threadTextsDelta,
} from "tau/host-extension";
import { CodexAppServer, type CodexAccount, type CodexLoginCompleted, type CodexModel } from "./app-server.js";
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
  SEARCH_KIT_ID,
  USAGE_KIT_ID,
  type CodexInstancesReport,
  type CodexStatusReport,
} from "./protocol.js";
import { createCodexRuntimeAdapter } from "./runtime-adapter.js";
import { CodexSessionStore, type CodexStoredModel } from "./session-store.js";
import { CodexThreadRuntimeBackend, MODEL_PROVIDER, codexBilling, storedModel, type CodexSessionInput, type CodexSessionLike } from "./thread-backend.js";
import { readCodexIdentity, type AccountIdentity } from "./account-identity.js";
import { codexLimitWindows, codexReadSnapshot, mergeCodexSnapshot, type CodexRateSnapshot, type LimitAccount } from "./limits.js";

export { codexBilling };

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
/** Quota windows move with every turn; reading them more often than this only costs requests. */
const LIMITS_TTL_MS = 5 * 60 * 1000;

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

/**
 * The models a new thread may start on, with the effort each offers; the first
 * entry is Codex's own default. Price and context come from the host's model data.
 */
export function codexNewThreadCatalog(models: readonly CodexStoredModel[], configured: { model?: string; effort?: string }, billing?: UiModelBilling): HostRuntimeNewThreadCatalog {
  const start = (configured.model ? models.find((model) => model.id === configured.model) : undefined) ?? models.find((model) => model.isDefault) ?? models[0];
  const shown = (model: CodexStoredModel): UiModel => ({
    provider: MODEL_PROVIDER,
    id: model.id,
    name: model.name,
    ...(billing ? { billing } : {}),
    ...(model.images !== undefined ? { images: model.images } : {}),
    ...(model.efforts.length > 0 ? { reasoning: true } : {}),
  });
  return {
    models: models.map(shown),
    ...(start ? { model: shown(start) } : {}),
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

const PLAN_NAMES: Record<string, string> = { free: "Free", go: "Go", plus: "Plus", pro: "Pro", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" };

/** The ways Codex signs in: its own login server for the browser, a device code, a key, or `codex login` in a terminal. */
export const CODEX_SIGN_IN_METHODS: readonly SignInMethod[] = [
  { id: "chatgpt", label: "Sign in with ChatGPT", kind: "browser", description: "Opens OpenAI's page in your browser; Codex finishes the sign-in on this computer." },
  { id: "device", label: "Use a device code", kind: "device-code", description: "Enter a code on OpenAI's page from any device, for a browser on another computer." },
  { id: "api-key", label: "Use an API key", kind: "api-key", description: "Billed per token to the key's account instead of a ChatGPT plan." },
  { id: "terminal", label: "Sign in in a terminal", kind: "terminal", description: "Runs codex login in a terminal you can see." },
];

/** Who Codex is signed in as, for the account row. */
export function codexSignInAccount(account: CodexAccount | undefined): SignInAccount {
  if (!account) return { signedIn: false };
  if (account.type === "chatgpt") {
    const chatgpt = account as { planType?: string; email?: string | null };
    const plan = chatgpt.planType ? `ChatGPT ${PLAN_NAMES[chatgpt.planType] ?? chatgpt.planType}` : "ChatGPT";
    return { signedIn: true, label: chatgpt.email || plan, ...(chatgpt.email ? { detail: plan } : {}), canSignOut: true };
  }
  return account.type === "apiKey"
    ? { signedIn: true, label: "API key", detail: "Billed per token", canSignOut: true }
    : { signedIn: true, label: "Signed in", canSignOut: true };
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(new Error("Sign-in cancelled."));
    else signal.addEventListener("abort", () => reject(new Error("Sign-in cancelled.")), { once: true });
  });
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
      const storePath = CodexSessionStore.defaultPath(options.sessionsDir ?? services.sessionsDir);
      const store = new CodexSessionStore({ filePath: storePath });
      const activity = new TurnActivityStore({ directory: join(dirname(storePath), "codex-activity") });
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

      /** Per instance: the quota windows last read or reported by a turn, and the login they belong to. */
      const limits = new Map<string, { at: number; snapshot?: CodexRateSnapshot; account?: CodexAccount; identity?: AccountIdentity; error?: string }>();
      const reading = new Map<string, Promise<void>>();
      const noteRateLimits = (id: string, update: unknown): void => {
        const held = limits.get(id);
        limits.set(id, { ...held, at: Date.now(), snapshot: mergeCodexSnapshot(held?.snapshot, update) });
      };
      /** Reads the windows through a short-lived app-server; nothing on the account changes. */
      const readLimits = (id: string): Promise<void> => {
        const running = reading.get(id);
        if (running) return running;
        const next = (async () => {
          await mkdir(services.stateDir, { recursive: true });
          const session = await spawnSession(id, {
            cwd: services.stateDir,
            onNotification: () => undefined,
            onRequest: async () => { throw new Error("No thread runs in a probe."); },
            onExit: () => undefined,
          });
          try {
            const account = await session.account?.();
            const read = account?.type === "chatgpt" ? await session.rateLimits?.() : undefined;
            // The home the app-server itself reports, so a test's never falls back to the real one.
            const identity = account?.type === "chatgpt" && session.codexHome ? await readCodexIdentity(session.codexHome) : undefined;
            limits.set(id, { at: Date.now(), ...(account ? { account } : {}), ...(read ? { snapshot: codexReadSnapshot(read) } : {}), ...(identity ? { identity } : {}) });
          } finally {
            await session.close().catch(() => undefined);
          }
        })().catch((error: unknown) => {
          limits.set(id, { ...limits.get(id), at: Date.now(), error: error instanceof Error ? error.message : String(error) });
        }).finally(() => reading.delete(id));
        reading.set(id, next);
        return next;
      };
      const limitAccount = (id: string): LimitAccount => {
        const held = limits.get(id);
        const base = { id: `${settings.kind(id)}:account`, runtime: settings.kind(id), label: settings.label(id), checkedAt: held?.at ?? Date.now(), ...(held?.identity ? { identity: held.identity } : {}) };
        const account = held?.account as { type?: string; planType?: string } | undefined;
        const plan = account?.planType ?? held?.snapshot?.planType ?? undefined;
        const windows = codexLimitWindows(held?.snapshot);
        if (windows.length > 0) return { ...base, ...(plan ? { plan } : {}), windows };
        if (held?.error) return { ...base, windows: [], unavailable: { reason: "failed", message: held.error } };
        if (account?.type === "apiKey") return { ...base, windows: [], unavailable: { reason: "unsupported", message: "An API key has no subscription limits." } };
        if (!account) return { ...base, windows: [], unavailable: { reason: "signed-out", message: "Codex is not signed in." } };
        return { ...base, ...(plan ? { plan } : {}), windows: [] };
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
        const latest = await npmLatestVersion(CODEX_NPM_PACKAGE, { cacheFile: join(services.stateDir, "latest-version.json"), env, ...(options.fetch ? { fetch: options.fetch } : {}) });
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
            await assertSupported(id);
            const backend = new CodexThreadRuntimeBackend(threadId, cwd, {
              adapter,
              store,
              activity,
              instance: id,
              configuredModel: () => readCodexConfiguredModel(home()),
              openSession: (input) => spawnSession(id, input),
              storedModels: () => store.listModels(id),
              models: () => cachedModels(id),
              onModels: (models) => void store.setModels(models, id).catch(() => undefined),
              permissionLevel: thread.permissionLevel,
              ...(thread.executionPolicy ? { executionPolicy: thread.executionPolicy } : {}),
              ...(thread.priceUsage ? { priceUsage: thread.priceUsage } : {}),
              onRateLimits: (snapshot) => noteRateLimits(id, snapshot),
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
          // The account's models, starting where config.toml points; the host keeps the answer and asks again now and then.
          newThreadCatalog: async () => {
            if (!locate(id)) return { models: [], thinkingLevels: {}, status: "not-installed", note: `The Codex CLI "${codexCommand(id)}" is not installed.` };
            const probe = await runProbe(id);
            if (!probe.account) return { models: [], thinkingLevels: {}, status: "sign-in-required", note: `${settings.label(id)} is not signed in. Sign in on its card under Settings → Providers.` };
            const models = probe.models.map(storedModel);
            await store.setModels(models, id).catch(() => undefined);
            return codexNewThreadCatalog(models, await readCodexConfiguredModel(home()), codexBilling(probe.account));
          },
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
      }, { access: "read" });
      context.registerCommand("instances", () => instancesReport(), { access: "read" });
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
      // Each thread's running total and its turns, for the Usage kit; read from the store, never from OpenAI.
      context.registerCommand("usage", async () => ({
        threads: (await store.list()).map((entry) => {
          const model = entry.model ?? entry.observedModel;
          return {
            threadId: entry.tauThreadId,
            ...(entry.codexThreadId ? { sessionId: entry.codexThreadId } : {}),
            cwd: entry.cwd,
            updatedAt: entry.updatedAt,
            ...(model ? { model } : {}),
            ...(entry.usage ? { usage: { ...entry.usage } } : {}),
            ...(entry.usageTurns ? { turns: entry.usageTurns } : {}),
          };
        }),
      }), { access: "read", callers: [USAGE_KIT_ID] });
      // Where each instance's CLI logs its sessions, for the Usage kit to count work outside Tau; read by that kit, not here.
      context.registerCommand("usage-logs", () => ({
        folders: settings.list().flatMap((instance) => {
          const home = codexHome(instanceEnv(instance.id));
          const billing = codexBilling(limits.get(instance.id)?.account);
          return ["sessions", "archived_sessions"].map((folder) => ({ format: "codex", path: join(home, folder), instance: settings.kind(instance.id), ...(billing ? { billing } : {}) }));
        }),
      }), { access: "read", callers: [USAGE_KIT_ID] });
      // What each thread said, for Search Kit to find threads nobody has open; only what it lacks.
      context.registerCommand(THREAD_TEXTS_COMMAND, async (input) => threadTextsDelta(await store.list(), input), { long: true, callers: [SEARCH_KIT_ID] });
      // The account's quota windows, for the Usage kit: read at most every few minutes, fresher when a turn reported them.
      context.registerCommand("usage-limits", async (input) => {
        const refresh = Boolean(input && typeof input === "object" && (input as { refresh?: unknown }).refresh);
        const ids = settings.list().map((instance) => instance.id).filter((id) => locate(id));
        await Promise.all(ids.map(async (id) => {
          const held = limits.get(id);
          if (!refresh && held && !held.error && Date.now() - held.at < LIMITS_TTL_MS) return;
          await Promise.race([readLimits(id), new Promise<void>((resolve) => setTimeout(resolve, 20_000).unref?.())]);
        }));
        return { accounts: ids.map(limitAccount) };
      }, { access: "read", long: true, callers: [USAGE_KIT_ID] });
      // Sessions the default instance's CLI ran on its own, for Onboarding to list and import as threads.
      context.registerCommand("import-scan", async () => {
        const held = await store.codexThreadIds();
        return { source: CODEX_BACKEND_KIND, ...await scanCodexSessions(codexSessionDirs(instanceEnv(DEFAULT_INSTANCE_ID)), (id) => held.has(id)) };
      }, { long: true, callers: [ONBOARDING_KIT_ID] });
      context.registerCommand("import-sessions", async (input) => {
        const outcome = await importCodexSessions(codexSessionDirs(instanceEnv(DEFAULT_INSTANCE_ID)), (input as { paths?: unknown } | undefined)?.paths, store);
        return { ...outcome, ...(outcome.imported.length ? { update: await services.sessions.refreshIndex() } : {}) };
      }, { long: true, callers: [ONBOARDING_KIT_ID] });

      // Signing in from the window: Codex's own login over its app server, or `codex login` in a terminal.
      const signInEnv = (id: string): Record<string, string> => {
        const added = settings.environment(id, {});
        const inherited = env[CODEX_HOME_VARIABLE] && !added[CODEX_HOME_VARIABLE] ? { [CODEX_HOME_VARIABLE]: env[CODEX_HOME_VARIABLE] } : {};
        return Object.fromEntries(Object.entries({ ...inherited, ...added }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      };
      const loginSession = async (id: string, completed: (event: CodexLoginCompleted) => void) => {
        await mkdir(services.stateDir, { recursive: true });
        return spawnSession(id, {
          cwd: services.stateDir,
          onNotification: (method, params) => { if (method === "account/login/completed") completed(params as CodexLoginCompleted); },
          onRequest: async () => { throw new Error("No thread runs during a sign-in."); },
          onExit: () => undefined,
        });
      };
      const signIn = registerSignIn(context, {
        defaultTarget: DEFAULT_INSTANCE_ID,
        report: async (id) => {
          requireInstance(id);
          if (!locate(id)) return { methods: CODEX_SIGN_IN_METHODS.map((method) => ({ ...method, unavailable: `Install Codex first; "${codexCommand(id)}" was not found.` })), account: { signedIn: false } };
          try {
            const probe = await Promise.race([
              runProbe(id),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Codex did not report its account within 20 s.")), 20_000).unref?.()),
            ]);
            return { methods: [...CODEX_SIGN_IN_METHODS], account: codexSignInAccount(probe.account), note: `Codex keeps its login in ${probe.codexHome ?? "its home"}; Tau stores none.` };
          } catch (error) {
            return { methods: [...CODEX_SIGN_IN_METHODS], account: { signedIn: false, detail: error instanceof Error ? error.message : String(error) } };
          }
        },
        signIn: async (id, method, flow) => {
          requireInstance(id);
          if (method === "terminal") {
            const path = await assertSupported(id);
            flow.show({ terminal: { command: commandLine(path, ["login"], signInEnv(id), process.platform) } });
            const ended = await flow.ask({ kind: "text", message: "Waiting for codex login to finish in the terminal." });
            flow.verifying();
            const account = (await runProbe(id, true)).account;
            if (!account) throw new Error(ended === "0" || ended === "done" ? "Codex still reports no account." : `codex login ended without signing in (${ended}).`);
            return `Signed in as ${codexSignInAccount(account).label}.`;
          }
          let complete: (event: CodexLoginCompleted) => void = () => undefined;
          const completed = new Promise<CodexLoginCompleted>((resolve) => { complete = resolve; });
          const session = await loginSession(id, (event) => complete(event));
          try {
            if (!session.loginStart) throw new Error("This Codex cannot sign in from Tau; sign in in a terminal.");
            if (method === "api-key") {
              const apiKey = await flow.ask({ kind: "secret", message: "Paste an OpenAI API key. Codex keeps it in its home.", placeholder: "sk-…" });
              flow.verifying("Handing the key to Codex…");
              await session.loginStart({ type: "apiKey", apiKey });
            } else {
              const started = await session.loginStart(method === "device" ? { type: "chatgptDeviceCode" } : { type: "chatgpt" });
              if (started.type === "chatgpt") flow.show({ browser: { url: started.authUrl, instructions: "Sign in with your ChatGPT account in the browser; Codex finishes the sign-in by itself." } });
              else if (started.type === "chatgptDeviceCode") flow.show({ deviceCode: { url: started.verificationUrl, code: started.userCode } });
              const loginId = "loginId" in started ? started.loginId : undefined;
              flow.signal.addEventListener("abort", () => { if (loginId) void session.loginCancel?.(loginId).catch(() => undefined); }, { once: true });
              const result = await Promise.race([completed, aborted(flow.signal)]);
              if (!result.success) throw new Error(result.error ?? "Codex did not finish the sign-in.");
              flow.verifying();
            }
            const account = await session.account?.();
            if (!account) throw new Error("Codex reports no account after the sign-in.");
            return `Signed in as ${codexSignInAccount(account).label}.`;
          } finally {
            await session.close().catch(() => undefined);
          }
        },
        signOut: async (id) => {
          requireInstance(id);
          const session = await loginSession(id, () => undefined);
          try {
            if (!session.logout) throw new Error("This Codex cannot sign out from Tau; run codex logout.");
            await session.logout();
          } finally {
            await session.close().catch(() => undefined);
          }
          return "Signed out of Codex.";
        },
        // The account decides the catalog and the probe: the backend is registered anew and asked again.
        changed: (id) => { if (settings.get(id)) register(id); },
      });

      for (const instance of settings.list()) register(instance.id);
      return () => {
        signIn.dispose();
        for (const id of [...states.keys()]) unregister(id);
      };
    },
  };
}

export default createCodexHostExtension;
