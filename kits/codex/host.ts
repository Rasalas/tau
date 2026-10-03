import { canonicalCodexHome, canonicalHomePath, codexHomeLayout, continuationEnvironment, prepareCodexHome } from "./home-layout.js";
import { RpcError } from "./rpc.js";
import { ResetCoordinator } from "./reset-coordinator.js";
import { codexResetCredits } from "./limits.js";
import { ChatGPTPlan, CHATGPT_PLAN_ARGS, CHATGPT_PLAN_METHOD, CHATGPT_USAGE_URL, planCatalog } from "./chatgpt-plan.js";
import { PLAN_SCOPE } from "./chatgpt-plan-oauth.js";
import { createManagedCodex, MANAGED_CODEX_VERSION } from "./managed-install.js";
import type { ChatGPTRegistration } from "./chatgpt-plan-store.js";
import type { ManagedCodexAsset } from "./managed-release.js";
import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_INSTANCE_ID,
  HostCommandError,
  RuntimeInstanceSettings,
  TurnActivityStore,
  cliCommandText,
  cliMaintenance,
  commandInvocation,
  commandLine,
  compareVersions,
  executableFingerprint,
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
  type CliPackageSpec,
  type HostRuntimeNewThreadCatalog,
  type RuntimeCompatibility,
  type RuntimeToolMaintenance,
  type RuntimeInstanceConfig,
  type RuntimeToolVersion,
  type SignInAccount,
  type SignInFlowContext,
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
import { codexNativeCapabilities } from "./native-capabilities.js";
import { codexToolArgs } from "./tools.js";
import {
  CODEX_BACKEND_KIND,
  CODEX_HOME_VARIABLE,
  CODEX_HOST_EXTENSION_ID,
  CODEX_NPM_PACKAGE,
  INSTANCES_EVENT,
  MANAGED_CODEX_EVENT,
  MIN_CODEX_VERSION,
  ONBOARDING_KIT_ID,
  SEARCH_KIT_ID,
  USAGE_KIT_ID,
  type ChatGPTPlanSummary,
  type CodexInstancesReport,
  type CodexStatusReport,
  type CodexThreadSettings,
  type ManagedCodexState,
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
  /** The managed release's archive; tests serve a fixture, production the pinned table. */
  managedAsset?: ManagedCodexAsset;
}

/** What `status` and the model list need of the CLI, asked without a thread. */
interface Probe { account?: CodexAccount; models: CodexModel[]; codexHome?: string; at: number }
const PROBE_TTL_MS = 10 * 60 * 1000;
/** Quota windows move with every turn; reading them more often than this only costs requests. */
const LIMITS_TTL_MS = 5 * 60 * 1000;

export const CODEX_COMMAND_VARIABLE = "TAU_CODEX_COMMAND";

/** Where Codex comes from; only these names are ever updated. */
export const CODEX_PACKAGE: CliPackageSpec = { npm: CODEX_NPM_PACKAGE, homebrew: { casks: ["codex"] } };

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

const PLAN_NAMES: Record<string, string> = { free: "Free", go: "Go", plus: "Plus", pro: "Pro", pro_max: "Pro Max", proMax: "Pro Max", promax: "Pro Max", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" };

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
  /** `key` is the executable's fingerprint: a CLI replaced in place is read again. */
  installed?: { path: string; version?: string; key?: string };
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
 * app data. Each instance uses either a Tau-managed ChatGPT plan connection
 * or the CLI's own login. Each instance — the default one and
 * any the user adds on the Providers page, with its own executable, home
 * (`CODEX_HOME`), environment and arguments — registers a backend of its own
 * (`codex`, `codex@<id>`), so a thread keeps its durable owner while compatible CLI accounts may execute its next turn.
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
      const plan = new ChatGPTPlan(join(services.stateDir, "chatgpt-plan"), options.fetch);
      const managed = createManagedCodex({ directory: join(services.stateDir, "managed-codex"), ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.managedAsset ? { asset: options.managedAsset } : {}) });
      let managedPath: string | undefined;
      /** An earlier pinned release is on disk: this host ran Tau's Codex before a Tau update. */
      let hadManaged = false;
      const managedReady = Promise.all([managed.resolveInstalled(), managed.hadEarlier()]).then(([path, earlier]) => { managedPath = path; hadManaged = earlier; });
      const signingOut = new Set<string>();
      const transitioning = new Set<string>();
      const openingThreads = new Map<string, number>();
      const threadAccounts = new Map<string, { backend: CodexThreadRuntimeBackend; account: string; change(account: string): void }>();
      const sessions = new Map<string, Set<CodexSessionLike>>();
      const sessionTokens = new WeakMap<CodexSessionLike, string>();
      const stopSessions = async (id: string) => {
        await Promise.all([...sessions.get(id) ?? []].map((session) => session.close().catch(() => undefined)));
        sessions.delete(id);
      };
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
      const managedHome = (id: string) => join(services.stateDir, "chatgpt-plan-homes", id);
      // Managed homes share sessions only by explicit instance configuration.
      const managedSharedHome = (id: string) => settings.home(id) ?? managedHome(id);
      const sessionHomeOf = async (id: string, managedAccount: boolean) => managedAccount
        ? canonicalHomePath(managedSharedHome(id)) : canonicalCodexHome(instanceEnv(id));
      const sessionEnvironment = async (id: string, managedAccount: boolean) => {
        if (!managedAccount) return prepareCodexHome(instanceEnv(id));
        const shared = settings.home(id);
        if (!shared || await canonicalHomePath(shared) === await canonicalHomePath(managedHome(id))) return { ...instanceEnv(id), CODEX_HOME: managedHome(id) };
        return prepareCodexHome({ ...instanceEnv(id), CODEX_HOME: shared, TAU_CODEX_AUTH_HOME: managedHome(id) });
      };
      const locate = (id: string): string | undefined => services.findCommand(codexCommand(id)) ?? (!settings.command(id).source ? managedPath : undefined);
      const planReady = (registration: ChatGPTRegistration): boolean => Boolean(registration.tokens?.scopes.includes(PLAN_SCOPE));
      /** Plan instances run Tau's Codex; so does a CLI instance without one of its own once Tau had fetched one. */
      const usesManaged = async (id: string): Promise<boolean> => {
        if (settings.command(id).source) return false;
        if (await plan.read(id)) return true;
        return !services.findCommand(codexCommand(id)) && (managedPath !== undefined || hadManaged);
      };
      const requirePlanRelease = (version: string | undefined): void => {
        if (!version || compareVersions(version, MANAGED_CODEX_VERSION) < 0) throw new Error(`ChatGPT plan usage requires Codex ${MANAGED_CODEX_VERSION} or newer. Clear the executable override to use the version managed by Tau.`);
      };

      /** Fetching the pinned release: one download for every instance, its progress pushed to every card. */
      let fetching: Promise<string> | undefined;
      let fetchState: ManagedCodexState | undefined;
      const installListeners = new Set<(progress: ManagedCodexState) => void>();
      const noteInstall = (progress: ManagedCodexState): void => {
        fetchState = progress.phase === "installed" ? undefined : progress;
        context.emit(MANAGED_CODEX_EVENT, progress);
        for (const listener of [...installListeners]) listener(progress);
      };
      const fetchManaged = (): Promise<string> => fetching ??= (async () => {
        let percent = -1;
        noteInstall({ version: MANAGED_CODEX_VERSION, phase: "downloading" });
        try {
          const path = await managed.ensure({
            onProgress: (event) => {
              if (event.phase === "installed") return;
              const now = event.totalBytes ? Math.floor(((event.downloadedBytes ?? 0) * 100) / event.totalBytes) : -1;
              if (event.phase === "downloading" && now === percent) return;
              percent = now;
              noteInstall({ version: MANAGED_CODEX_VERSION, ...event });
            },
          });
          managedPath = path;
          noteInstall({ version: MANAGED_CODEX_VERSION, phase: "installed" });
          for (const instance of settings.list()) if (await usesManaged(instance.id)) register(instance.id);
          return path;
        } catch (error) {
          noteInstall({ version: MANAGED_CODEX_VERSION, phase: "failed", error: error instanceof Error ? error.message : String(error) });
          throw error;
        } finally { fetching = undefined; }
      })();
      const planSummary = (id: string, registration: ChatGPTRegistration): ChatGPTPlanSummary => ({
        instance: id,
        signedIn: planReady(registration),
        label: registration.email ?? "ChatGPT account",
        usageUrl: CHATGPT_USAGE_URL,
        ...(!settings.command(id).source && !managedPath && !fetching ? { needsInstall: true } : {}),
      });
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
      /** The instance's CLI and its version; read again once the file changed (an update). */
      const cli = async (id: string): Promise<{ path: string; version?: string }> => {
        await managedReady;
        const registration = await plan.read(id);
        const path = registration && !settings.command(id).source ? managedPath : locate(id);
        if (!path && await usesManaged(id)) {
          if (fetchState?.phase === "failed") throw new Error(`Tau could not fetch Codex ${MANAGED_CODEX_VERSION}: ${fetchState.error ?? "unknown error"}`);
          void fetchManaged().catch(() => undefined);
          throw new Error(`Tau is fetching Codex ${MANAGED_CODEX_VERSION}; this instance uses it once it is ready.`);
        }
        if (!path) throw new Error(`The Codex CLI "${codexCommand(id)}" was not found on the PATH of your login shell. Continue with ChatGPT to let Tau fetch Codex, install it (brew install --cask codex, or npm install -g ${CODEX_NPM_PACKAGE}), or set its path under Settings → Providers.`);
        const entry = state(id);
        const key = await executableFingerprint(path);
        if (entry.installed?.path !== path || entry.installed.key !== key) {
          // Another program answers now: what the old one said about models and account is stale.
          if (entry.installed) entry.probe = undefined;
          entry.installed = { path, ...(key ? { key } : {}), ...(await readVersion(path).then((version) => version ? { version } : {})) };
        }
        return entry.installed;
      };
      const assertSupported = async (id: string): Promise<string> => {
        const { path, version } = await cli(id);
        if (await plan.read(id)) requirePlanRelease(version);
        const verdict = await compatibility(path, version);
        if (verdict?.status !== "broken") return path;
        const older = version !== undefined && compareVersions(version, MIN_CODEX_VERSION) < 0;
        const reason = older ? `Codex ${version} is older than ${MIN_CODEX_VERSION}, the oldest release Tau speaks to.` : `Codex ${version} does not work with Tau.`;
        const fix = verdict.installCommand ? `Install ${verdict.recommendedVersion} with: ${verdict.installCommand}` : `Update it with: ${await updateCommand(path)}`;
        throw new Error(`${reason} ${fix}`);
      };

      const spawnSession = async (id: string, input: CodexSessionInput): Promise<CodexSessionLike> => {
        if (signingOut.has(id)) throw new Error("This ChatGPT account is signing out.");
        const registration = await plan.read(id);
        const credentials = registration ? await plan.credentials(id) : undefined;
        const command = await assertSupported(id);
        const cliEnv = await sessionEnvironment(id, Boolean(credentials));
        // Custom launch overrides can disable or replace the configured native plugins.
        const nativeCapabilities = input.tools || settings.args(id).length ? [] : await codexNativeCapabilities(codexHomeLayout(cliEnv).effective);
        // A thread's session reaches Tau's tools; without the endpoint it still runs, only without them.
        const mcp = input.threadId
          ? await services.mcp.connect({ sessionId: input.threadId, cwd: input.cwd, ...(nativeCapabilities.length ? { nativeCapabilities } : {}) }, input.tools ? { tools: input.tools } : undefined).catch(() => undefined)
          : undefined;
        const tau = mcp ? codexMcpLaunch(mcp) : { args: [], env: {} };
        if (input.threadId) {
          const sessionHome = await sessionHomeOf(id, Boolean(credentials));
          await store.setSessionHome(input.threadId, input.cwd, sessionHome);
        }
        const launch = { args: [...tau.args, ...(input.tools ? codexToolArgs(input.tools) : []), ...settings.args(id), ...(!credentials && codexHomeLayout(instanceEnv(id)).overlay ? ["-c", 'cli_auth_credentials_store="file"'] : []), ...(credentials ? CHATGPT_PLAN_ARGS : [])], env: tau.env };
        const sessionEnv = { ...cliEnv, ...launch.env, ...(credentials ? { ACCESS_TOKEN: credentials.tokens!.accessToken } : {}) };
        const track = (session: CodexSessionLike): CodexSessionLike => {
          const held = sessions.get(id) ?? new Set<CodexSessionLike>();
          for (const previous of held) if (previous.closed) held.delete(previous);
          held.add(session);
          sessions.set(id, held);
          if (credentials) sessionTokens.set(session, credentials.tokens!.accessToken);
          if (credentials) {
            session.account = async () => ({ type: "chatgpt", email: credentials.email ?? null, planType: "" });
            const catalog = session.models.bind(session);
            session.models = async () => {
              const [allowed, codex] = await Promise.all([plan.models(id), catalog()]);
              return planCatalog(allowed, codex).map((model) => ({ ...model, serviceTiers: [], additionalSpeedTiers: [], defaultServiceTier: null }));
            };
          }
          return session;
        };
        const accept = async (session: CodexSessionLike) => {
          if (signingOut.has(id) || credentials && !(await plan.read(id))?.tokens) {
            await session.close();
            throw new Error("This ChatGPT account signed out while starting Codex.");
          }
          return track(session);
        };
        if (options.openSession) return accept(await options.openSession({ ...input, command, args: launch.args, env: sessionEnv, instance: id }));
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
        return accept(server);
      };

      /** Account and models, from a short-lived app-server that starts no thread. */
      const runProbe = async (id: string, fresh = false): Promise<Probe> => {
        const entry = state(id);
        await cli(id).catch(() => undefined);
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
      const limits = new Map<string, { at: number; snapshot?: CodexRateSnapshot; resetCredits?: LimitAccount["resetCredits"]; account?: CodexAccount; identity?: AccountIdentity; error?: string; managementUrl?: string }>();
      const resets = new ResetCoordinator(services.stateDir);
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
          const registration = await plan.read(id);
          if (registration) {
            limits.set(id, { at: Date.now(), managementUrl: CHATGPT_USAGE_URL,
              ...(planReady(registration) ? { account: { type: "chatgpt", email: registration.email ?? null, planType: "" } } : {}) });
            return;
          }
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
            const resetCredits = codexResetCredits(read);
            const accountKey = identity?.key ?? await realpath(codexHome(instanceEnv(id))).catch(() => codexHome(instanceEnv(id)));
            const pending = await resets.hasPending(accountKey);
            limits.set(id, { at: Date.now(), ...(account ? { account } : {}), ...(read ? { snapshot: codexReadSnapshot(read), resetCredits: resetCredits || pending ? { availableCount: 0, ...resetCredits, pending } : undefined } : {}), ...(identity ? { identity } : {}) });
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
        const base = { id: `${settings.kind(id)}:account`, runtime: settings.kind(id), label: settings.label(id), checkedAt: held?.at ?? Date.now(), ...(held?.resetCredits ? { resetCredits: held.resetCredits } : {}), ...(held?.identity ? { identity: held.identity } : {}) };
        const account = held?.account as { type?: string; planType?: string } | undefined;
        const accountPlan = account?.planType ?? held?.snapshot?.planType ?? undefined;
        if (held?.managementUrl) return { ...base, managementUrl: held.managementUrl, windows: [], unavailable: { reason: account ? "unsupported" : "signed-out", message: account ? "ChatGPT manages this connection’s usage and app limits." : "This ChatGPT account is signed out." } };
        const windows = codexLimitWindows(held?.snapshot);
        if (windows.length > 0) return { ...base, ...(accountPlan ? { plan: accountPlan } : {}), windows };
        if (held?.error) return { ...base, windows: [], unavailable: { reason: "failed", message: held.error } };
        if (account?.type === "apiKey") return { ...base, windows: [], unavailable: { reason: "unsupported", message: "An API key has no subscription limits." } };
        if (!account) return { ...base, windows: [], unavailable: { reason: "signed-out", message: "Codex is not signed in." } };
        return { ...base, ...(accountPlan ? { plan: accountPlan } : {}), windows: [] };
      };

      context.registerCommand("usage-redeem-reset", async (input) => {
        const runtime = (input as { runtime?: unknown } | undefined)?.runtime;
        const instance = settings.list().find((entry) => settings.kind(entry.id) === runtime);
        if (!instance) throw new HostCommandError("Unknown Codex account.");
        const id = instance.id;
        if (await plan.read(id)) throw new HostCommandError("Manage resets in ChatGPT Settings for this connection.");
        await readLimits(id);
        const accountKey = limits.get(id)?.identity?.key ?? await realpath(codexHome(instanceEnv(id))).catch(() => codexHome(instanceEnv(id)));
        return resets.redeem(accountKey, async (key) => {
          await readLimits(id);
          if (limits.get(id)?.error) throw new HostCommandError("Codex could not read this account. Retry to check the same request.");
          const expectedIdentity = (input as { identity?: unknown } | undefined)?.identity;
          if (expectedIdentity !== undefined && limits.get(id)?.identity?.key !== expectedIdentity) throw Object.assign(new HostCommandError("The account changed. Refresh before using a reset."), { settled: true });
          if (limits.get(id)?.account?.type !== "chatgpt") throw new HostCommandError("Sign in with ChatGPT to redeem resets.");
          const session = await spawnSession(id, { cwd: services.stateDir, onNotification: () => undefined, onRequest: async () => { throw new Error("No thread runs during a reset."); }, onExit: () => undefined });
          try {
            if (!session.consumeResetCredit) throw Object.assign(new HostCommandError("This Codex version does not support resets. Update Codex."), { settled: true });
            const response = await session.consumeResetCredit(key) as { outcome?: unknown };
            if (!["reset", "nothingToReset", "alreadyRedeemed", "noCredit"].includes(String(response?.outcome))) throw new HostCommandError("Codex could not confirm the reset. Retry to check the same request.");
            await readLimits(id);

            if (response.outcome === "reset" && (limits.get(id)?.error || !codexLimitWindows(limits.get(id)?.snapshot).length)) {
              throw Object.assign(new HostCommandError("The reset was applied, but the new limits could not be confirmed. Refresh to check."), { settled: true });
            }
            return response.outcome;
          } catch (error) {
            if ((error as { settled?: boolean }).settled) throw error;
            if (error instanceof RpcError && error.code === -32601) throw Object.assign(new HostCommandError("This Codex version does not support resets. Update Codex."), { settled: true });
            throw new HostCommandError("Codex could not confirm the reset. Retry to check the same request.");
          }
          finally { await session.close().catch(() => undefined); }
        }, (input as { checkPending?: unknown } | undefined)?.checkPending === true);
      }, { long: true, callers: [USAGE_KIT_ID] });

      const cachedModels = async (id: string): Promise<CodexStoredModel[]> => {
        const stored = await store.listModels(id);
        if (stored.length > 0) return stored;
        const models = (await runProbe(id)).models.map(storedModel);
        await store.setModels(models, id);
        return models;
      };

      const record = (entry: Awaited<ReturnType<CodexSessionStore["list"]>>[number]): HostBackendThreadRecord => {
        const usage = store.talliesOf(entry.tauThreadId);
        return {
          threadId: entry.tauThreadId,
          cwd: entry.cwd,
          ...(entry.title ? { title: entry.title } : {}),
          updatedAt: entry.updatedAt,
          messages: entry.messages,
          ...(usage.length ? { usage } : {}),
        };
      };

      /** How this instance's Codex is installed and what updates it; Homebrew's own release for a cask. */
      const maintenanceOf = async (id: string): Promise<RuntimeToolMaintenance> => {
        const { path, version } = await cli(id);
        if (path === managedPath) return { tool: "codex", installed: version, install: { method: "unknown", label: "Managed by Tau", path, realPath: path, note: "Tau pins and verifies this Codex release, and fetches the next one itself when a Tau update pins it." } };
        return cliMaintenance({
          tool: "codex",
          path,
          ...(version ? { installed: version } : {}),
          spec: CODEX_PACKAGE,
          findCommand: (name) => services.findCommand(name),
          cacheFile: join(services.stateDir, "latest-version.json"),
          env,
          commandEnv: await signInEnv(id),
          home: homedir(),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
      };

      const versionOf = async (id: string): Promise<RuntimeToolVersion | undefined> => {
        const { path, version } = await cli(id);
        if (path === managedPath) return { tool: "codex", installed: version, compatibility: await compatibility(path, version) };
        const maintenance = await maintenanceOf(id);
        const verdict = await compatibility(path, version);
        return {
          tool: "codex",
          ...(version ? { installed: version } : {}),
          ...(maintenance.latest ? { latest: maintenance.latest } : {}),
          updateCommand: maintenance.update ? runtimeUpdateCommand(CODEX_BACKEND_KIND, cliCommandText(maintenance.update), env) : await updateCommand(path),
          ...(verdict ? { compatibility: verdict } : {}),
        };
      };

      const providerFor = (id: string): HostRuntimeBackendProvider => {
        const kind = settings.kind(id);
        const adapter = createCodexRuntimeAdapter(kind);
        const home = async (): Promise<string> => await plan.read(id) ? managedSharedHome(id) : codexHome(instanceEnv(id));
        return {
          kind,
          label: settings.label(id),
          order: 20,
          adapter,
          modelProvider: "openai",
          homeProviders: ["openai"],
          listThreads: async () => (await store.list(id)).map(record),
          removeThread: async (threadId) => {
            threadAccounts.delete(threadId);
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
            if (transitioning.has(id)) throw new Error("Finish or cancel this instance’s ChatGPT sign-in before starting a thread.");
            openingThreads.set(id, (openingThreads.get(id) ?? 0) + 1);
            try {
              await managedReady;
              // Usually fetched at start already; otherwise the card and the composer show the progress.
              if (!managedPath && await usesManaged(id)) await fetchManaged();
              await assertSupported(id);
              let account = (await store.get(threadId))?.accountInstance ?? id;
              requireInstance(account);
              const accountHome = async () => await plan.read(account) ? managedSharedHome(account) : codexHome(instanceEnv(account));
              const backend = new CodexThreadRuntimeBackend(threadId, cwd, {
                adapter,
                store,
                activity,
                instance: id,
                configuredModel: async () => readCodexConfiguredModel(await accountHome()),
                openSession: (input) => spawnSession(account, input),
                sessionCurrent: async (session) => {
                  if (!await plan.read(account)) return !sessionTokens.has(session);
                  return (await plan.credentials(account)).tokens!.accessToken === sessionTokens.get(session);
                },
                storedModels: () => store.listModels(account),
                models: () => cachedModels(account),
                onModels: (models) => void store.setModels(models, account).catch(() => undefined),
                permissionLevel: thread.permissionLevel,
                ...(thread.executionPolicy ? { executionPolicy: thread.executionPolicy } : {}),
                ...(thread.priceUsage ? { priceUsage: thread.priceUsage } : {}),
                onRateLimits: (snapshot) => noteRateLimits(account, snapshot),
                onUsageLimit: () => { void plan.read(account).then((registration) => { if (registration) context.emit("chatgpt-plan-limit", { instance: account }); }); },
                ...(tools ? { tools } : {}),
                onMessage: thread.onMessage,
                onEvent: thread.onEvent,
                ask: thread.ask,
              });
              await backend.start(resume ? "resume" : "create");
              threadAccounts.set(threadId, { backend, get account() { return account; }, change: (next) => { account = next; } });
              return backend;
            } finally { openingThreads.set(id, (openingThreads.get(id) ?? 1) - 1); }
          },
          composerCommands: () => [],
          version: () => versionOf(id),
          maintenance: async () => locate(id) ? maintenanceOf(id) : undefined,
          programKey: async () => executableFingerprint((await cli(id).catch(() => undefined))?.path),
          // The account's models, starting where config.toml points; the host keeps the answer and asks again now and then.
          newThreadCatalog: async () => {
            await managedReady;
            if (!managedPath && await plan.read(id) && await usesManaged(id)) return { models: [], thinkingLevels: {}, status: "not-installed", note: fetching ? `Tau is fetching Codex ${MANAGED_CODEX_VERSION}; its progress is on this account’s Providers card.` : "Install the Codex version managed by Tau on this account’s Providers card." };
            if (!locate(id)) return { models: [], thinkingLevels: {}, status: "not-installed", note: `The Codex CLI "${codexCommand(id)}" is not installed.` };
            const probe = await runProbe(id);
            if (!probe.account) return { models: [], thinkingLevels: {}, status: "sign-in-required", note: `${settings.label(id)} is not signed in. Sign in on its card under Settings → Providers.` };
            const models = probe.models.map(storedModel);
            await store.setModels(models, id).catch(() => undefined);
            return codexNewThreadCatalog(models, await readCodexConfiguredModel(await home()), codexBilling(probe.account));
          },
        };
      };

      /** Registers the instance's backend anew, so core asks its version again and republishes. */
      const register = (id: string): void => {
        const entry = state(id);
        entry.unregister?.();
        entry.installed = undefined;
        entry.probe = undefined;
        limits.delete(id);
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
        await managedReady;
        const id = instanceInput(input);
        requireInstance(id);
        const { command, source } = settings.command(id);
        const fresh = Boolean(input && typeof input === "object" && (input as { fresh?: unknown }).fresh);
        const registration = await plan.read(id);
        const base = { instance: id, command, ...(source ? { commandSource: source } : {}), ...(registration ? { chatgptPlan: planSummary(id, registration) } : {}) };
        let found: { path: string; version?: string };
        try {
          if (fresh) state(id).installed = undefined;
          found = await cli(id);
        } catch (error) {
          // Read after cli(), which may just have started the fetch.
          const waiting = !managedPath && fetchState && await usesManaged(id) ? { managedInstall: fetchState, ...(registration ? { chatgptPlan: planSummary(id, registration) } : {}) } : {};
          return { ...base, ...waiting, message: error instanceof Error ? error.message : String(error) };
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
      // Retries a fetch that failed, or repairs the files; progress arrives as MANAGED_CODEX_EVENT.
      context.registerCommand("managed-codex-install", async (input) => {
        const id = instanceInput(input);
        requireInstance(id);
        await fetchManaged();
        register(id);
        return { installed: true };
      }, { long: true });
      context.registerCommand("chatgpt-plan-account", async (input) => {
        const threadId = (input as { threadId?: unknown } | undefined)?.threadId;
        const id = (typeof threadId === "string" ? threadAccounts.get(threadId)?.account : undefined) ?? instanceInput(input);
        requireInstance(id);
        const registration = await plan.read(id);
        return registration ? planSummary(id, registration) : undefined;
      }, { access: "read" });
      const heldThread = (input: unknown) => {
        const threadId = (input as { threadId?: unknown } | undefined)?.threadId;
        const held = typeof threadId === "string" ? threadAccounts.get(threadId) : undefined;
        if (!held) throw new HostCommandError("Open a Codex thread first.");
        return held;
      };
      const accountChoices = async (held: ReturnType<typeof heldThread>) => {
        const current = held.account;
        const currentManaged = Boolean(await plan.read(current));
        const shared = await sessionHomeOf(current, currentManaged);
        const effectivePath = currentManaged ? managedHome(current) : codexHomeLayout(instanceEnv(current)).effective;
        const effective = await canonicalHomePath(effectivePath);
        return Promise.all(settings.list().map(async (entry) => {
          let reason: string | undefined;
          if (entry.id !== current) {
            if (transitioning.has(entry.id) || signingOut.has(entry.id)) reason = "Finish signing in to this account first.";
            else if (currentManaged !== Boolean(await plan.read(entry.id))) reason = "CLI and managed ChatGPT connections use different inference providers.";
            else if (currentManaged && (!settings.home(current) || !settings.home(entry.id))) reason = "Configure the same explicit shared home on both managed ChatGPT accounts first.";
            else if (await sessionHomeOf(entry.id, currentManaged) !== shared) reason = "This account has a different shared CODEX_HOME. Managed accounts must explicitly configure the same shared home before starting their threads.";
            else if ((await canonicalHomePath(currentManaged ? managedHome(entry.id) : codexHomeLayout(instanceEnv(entry.id)).effective)) === effective) reason = "Set a separate TAU_CODEX_AUTH_HOME for this account's credentials.";
            else if (codexCommand(entry.id) !== codexCommand(current) || JSON.stringify(settings.args(entry.id)) !== JSON.stringify(settings.args(current)) || continuationEnvironment(instanceEnv(entry.id)) !== continuationEnvironment(instanceEnv(current))) reason = "This account uses a different Codex launch configuration.";
            else {
              const saved = currentManaged ? await plan.read(entry.id) : undefined;
              const probe = currentManaged ? undefined : await runProbe(entry.id).catch(() => undefined);
              if (currentManaged ? !saved?.tokens?.scopes.includes(PLAN_SCOPE) : !probe?.account) reason = "Sign in to this account on its Providers card first.";
            }
          }
          return { id: entry.id, label: settings.label(entry.id), ...(reason ? { reason } : {}) };
        }));
      };
      const threadSettings = async (held: ReturnType<typeof heldThread>): Promise<CodexThreadSettings> => {
        await held.backend.models();
        return {
          account: held.account,
          accounts: await accountChoices(held),
          serviceTier: await plan.read(held.account) ? { selected: null, defaultTier: null, choices: [] } : held.backend.serviceTierState(),
        };
      };
      context.registerCommand("thread-settings", (input) => threadSettings(heldThread(input)), { access: "read" });
      context.registerCommand("set-thread-tier", async (input) => {
        const held = heldThread(input);
        const tier = (input as { tier?: unknown }).tier;
        if (tier !== null && typeof tier !== "string") throw new HostCommandError("Choose a Codex service tier or the provider default.");
        if (await plan.read(held.account)) throw new HostCommandError("Managed ChatGPT connections do not offer service tiers.");
        await held.backend.setServiceTier(tier);
        context.emit("thread-settings", { threadId: held.backend.threadId });
        return threadSettings(held);
      });
      context.registerCommand("switch-thread-account", async (input) => {
        const held = heldThread(input);
        const account = (input as { account?: unknown }).account;
        const choice = (await accountChoices(held)).find((entry) => entry.id === account);
        if (!choice) throw new HostCommandError("Choose an existing Codex account.");
        if (choice.reason) throw new HostCommandError(choice.reason);
        if (choice.id !== held.account) await held.backend.switchAccount(choice.id, held.change, held.account);
        context.emit("thread-settings", { threadId: held.backend.threadId });
        return threadSettings(held);
      });
      context.registerCommand("instances", () => instancesReport(), { access: "read" });
      // Adds or edits an instance from the Providers page; its backend is registered anew.
      context.registerCommand("save-instance", async (input) => {
        const requested = (input as { instance?: unknown } | undefined)?.instance as RuntimeInstanceConfig | undefined;
        if (!requested || typeof requested.id !== "string") throw new HostCommandError("Name the instance to save.");
        if (requested.id === DEFAULT_INSTANCE_ID && requested.command !== settings.get(DEFAULT_INSTANCE_ID)?.command && settings.command(DEFAULT_INSTANCE_ID).source === "env") {
          throw new HostCommandError(`${CODEX_COMMAND_VARIABLE} is set in Tau's environment and decides the path.`);
        }
        if (requested.command && !services.findCommand(requested.command)) throw new HostCommandError(`No executable at "${requested.command}".`);
        if (requested.args?.includes("ignore_default_excludes") && await plan.read(requested.id)) {
          throw new HostCommandError("This instance uses a ChatGPT plan: Codex keeps variables named *TOKEN* away from the commands it runs, so ignore_default_excludes cannot be set here.");
        }
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
        if (await plan.read(id)) {
          signingOut.add(id);
          try {
            await stopSessions(id);
            const { revoked, message } = await plan.signOut(id);
            if (!revoked) throw new HostCommandError(message);
          } finally { signingOut.delete(id); }
        }
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
        const ids = (await Promise.all(settings.list().map(async (instance) => locate(instance.id) || await plan.read(instance.id) ? instance.id : undefined))).filter((id): id is string => id !== undefined);
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
        const outcome = await importCodexSessions(codexSessionDirs(instanceEnv(DEFAULT_INSTANCE_ID)), (input as { paths?: unknown } | undefined)?.paths, store, codexBilling(limits.get(DEFAULT_INSTANCE_ID)?.account));
        return { ...outcome, ...(outcome.imported.length ? { update: await services.sessions.refreshIndex() } : {}) };
      }, { long: true, callers: [ONBOARDING_KIT_ID] });

      // Signing in from the window: Codex's own login over its app server, or `codex login` in a terminal.
      const signInEnv = async (id: string): Promise<Record<string, string>> => {
        const prepared = await prepareCodexHome(instanceEnv(id));
        const added = settings.environment(id, {});
        const inherited = env[CODEX_HOME_VARIABLE] && !added[CODEX_HOME_VARIABLE] ? { [CODEX_HOME_VARIABLE]: env[CODEX_HOME_VARIABLE] } : {};
        return Object.fromEntries(Object.entries({ ...inherited, ...added, ...(codexHomeLayout(instanceEnv(id)).overlay ? { CODEX_HOME: prepared.CODEX_HOME } : {}) }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
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
      const ownsCliThreads = async (id: string) => (await store.list()).some((entry) => (entry.instance ?? DEFAULT_INSTANCE_ID) === id || entry.accountInstance === id);
      /** A cancelled sign-in stops waiting; the download goes on for the next attempt. */
      const waitForManaged = async (flow: SignInFlowContext): Promise<void> => {
        const say = (progress: ManagedCodexState) => {
          const percent = progress.totalBytes ? ` ${Math.floor(((progress.downloadedBytes ?? 0) * 100) / progress.totalBytes)}%` : "";
          if (progress.phase === "downloading" || progress.phase === "extracting") flow.verifying(`Downloading Codex ${MANAGED_CODEX_VERSION} for Tau…${progress.phase === "downloading" ? percent : ""}`);
        };
        say(fetchState ?? { version: MANAGED_CODEX_VERSION, phase: "downloading" });
        installListeners.add(say);
        try { await Promise.race([fetchManaged(), aborted(flow.signal)]); }
        finally { installListeners.delete(say); }
      };
      const signIn = registerSignIn(context, {
        defaultTarget: DEFAULT_INSTANCE_ID,
        report: async (id) => {
          requireInstance(id);
          await managedReady;
          const registration = await plan.read(id);
          const planMethod = !registration && await ownsCliThreads(id) ? { ...CHATGPT_PLAN_METHOD, unavailable: "Add a Codex instance to use your ChatGPT plan; this instance keeps its existing CLI threads." } : CHATGPT_PLAN_METHOD;
          if (registration) {
            const summary = planSummary(id, registration);
            return { methods: [planMethod], account: { signedIn: summary.signedIn, label: summary.label, detail: summary.signedIn ? "Using ChatGPT plan" : "Sign in again to this account", canSignOut: Boolean(registration.tokens) }, note: "Tau keeps this account’s credentials in a file on this computer that only your user account can read. Add an instance for another account." };
          }
          if (!locate(id)) return { methods: [planMethod, ...CODEX_SIGN_IN_METHODS.map((method) => ({ ...method, unavailable: `Install Codex first; "${codexCommand(id)}" was not found.` }))], account: { signedIn: false } };
          try {
            const probe = await Promise.race([
              runProbe(id),
              new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Codex did not report its account within 20 s.")), 20_000).unref?.()),
            ]);
            return { methods: [planMethod, ...CODEX_SIGN_IN_METHODS], account: codexSignInAccount(probe.account), note: `Codex keeps its login in ${probe.codexHome ?? "its home"}; Tau stores none.` };
          } catch (error) {
            return { methods: [planMethod, ...CODEX_SIGN_IN_METHODS], account: { signedIn: false, detail: error instanceof Error ? error.message : String(error) } };
          }
        },
        signIn: async (id, method, flow) => {
          requireInstance(id);
          if (method === CHATGPT_PLAN_METHOD.id) {
            const initial = !await plan.read(id);
            if (initial) {
              if (await ownsCliThreads(id) || openingThreads.get(id)) throw new Error("This instance already has CLI threads. Add a Codex instance to use your ChatGPT plan without changing their sessions.");
              transitioning.add(id);
            }
            try {
              await managedReady;
              if (settings.command(id).source) requirePlanRelease((await cli(id)).version);
              else if (!managedPath) await waitForManaged(flow);
              await stopSessions(id);
              return await plan.signIn(id, flow);
            } finally { transitioning.delete(id); }
          }
          if (await plan.read(id)) throw new Error("This instance uses its saved ChatGPT account. Add another instance for a CLI login.");
          if (method === "terminal") {
            const path = await assertSupported(id);
            flow.show({ terminal: { command: commandLine(path, [...settings.args(id), ...(codexHomeLayout(instanceEnv(id)).overlay ? ["-c", 'cli_auth_credentials_store="file"'] : []), "login"], await signInEnv(id), process.platform) } });
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
          if (await plan.read(id)) {
            signingOut.add(id);
            try {
              await stopSessions(id);
              return (await plan.signOut(id)).message;
            } finally {
              await stopSessions(id);
              signingOut.delete(id);
            }
          }
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
      // After a Tau update pinned another release, the instances that ran the old one fetch it without being asked.
      void managedReady.then(async () => {
        if (managedPath) { await managed.prune(); return; }
        for (const instance of settings.list()) if (await usesManaged(instance.id)) { await fetchManaged(); return; }
      }).catch(() => undefined);
      return () => {
        signIn.dispose();
        for (const id of [...states.keys()]) unregister(id);
      };
    },
  };
}

export default createCodexHostExtension;
