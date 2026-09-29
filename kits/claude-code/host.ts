import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_INSTANCE_ID,
  HostCommandError,
  RuntimeInstanceSettings,
  cliCommandText,
  cliMaintenance,
  commandInvocation,
  commandLine,
  executableFingerprint,
  packageInstallCommand,
  packageUpdateCommand,
  registerSignIn,
  runtimeUpdateCommand,
  runtimeVersionPolicy,
  skillInvocationCommand,
  splitArguments,
  updateAvailable,
  versionCompatibility,
  type CliPackageSpec,
  type HostBackendThreadRecord,
  type HostExtension,
  type HostExtensionServices,
  type HostRuntimeBackendProvider,
  type RuntimeInstanceConfig,
  type RuntimeToolMaintenance,
  type RuntimeToolVersion,
  type SignInMethod,
  type UiComposerCommand,
  type UiModelBilling,
  type VersionPolicy,
  THREAD_TEXTS_COMMAND,
  threadTextsDelta,
} from "tau/host-extension";
import { readAgentSdkIdentity, type AccountIdentity } from "./account-identity.js";
import { claudeConfigDir, claudeProjectDirs, importClaudeSessions, scanClaudeSessions } from "./history-import.js";
import {
  CLAUDE_CODE_BACKEND_KIND,
  CLAUDE_CODE_HOST_EXTENSION_ID,
  CLAUDE_HOME_VARIABLE,
  INSTANCES_EVENT,
  ONBOARDING_KIT_ID,
  RESUME_QUESTION_OFF_EVENT,
  SEARCH_KIT_ID,
  USAGE_KIT_ID,
  type ClaudeInstancesReport,
  type ClaudeStatusReport,
  type ResumeQuestionOffEvent,
} from "./protocol.js";
import { mergeWindows, rateLimitEventWindow, usageReadWindows, type LimitAccount, type LimitWindow } from "./limits.js";
import { authBilling, claudeAuthAccount, describeAccount, probeBilling, probeNewThreadCatalog, readClaudeAuth, readClaudeVersion, type ClaudeAuthStatus, type ClaudeProbe } from "./probe.js";
import { createClaudeCodeRuntimeAdapter, sdkExtraArgs, type ClaudeCodeAgentRuntimeAdapter, type ClaudeCodeRuntimeOptions } from "./runtime-adapter.js";
import { ClaudeRuntimeSessionStore } from "./session-store.js";
import { ClaudeThreadRuntimeBackend } from "./thread-backend.js";

export { CLAUDE_CODE_BACKEND_KIND, CLAUDE_CODE_HOST_EXTENSION_ID };

export interface ClaudeCodeHostExtensionOptions {
  /** A prepared adapter for the default instance (tests inject a fake transport); the CLI adapter otherwise. */
  adapter?: ClaudeCodeAgentRuntimeAdapter;
  /** Builds another instance's adapter; tests script one. */
  createAdapter?(options: ClaudeCodeRuntimeOptions): ClaudeCodeAgentRuntimeAdapter;
  /** The session directory the store is placed beside; `services.sessionsDir` otherwise. */
  sessionsDir?: string;
  /** Commands offered instead of the shared skill directories (tests). */
  commands?: readonly UiComposerCommand[];
  /** The npm registry, for the newest release; tests answer it. */
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  /** `claude --version`; tests answer it. */
  readVersion?(path: string): Promise<string | undefined>;
  /** `auth status --json`; the CLI itself by default. */
  readAuth?(path: string, env: NodeJS.ProcessEnv): Promise<ClaudeAuthStatus | undefined>;
}

const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";
/** Where the CLI comes from; its own installer's copy updates itself. Only these names are ever updated. */
export const CLAUDE_PACKAGE: CliPackageSpec = {
  npm: CLAUDE_NPM_PACKAGE,
  homebrew: { casks: ["claude-code"] },
  native: { args: ["update"], paths: ["/.local/share/claude/", "/.claude/local/"] },
};
/** The plan's windows move with every turn; reading them more often than this only costs requests. */
const LIMITS_TTL_MS = 5 * 60 * 1000;

/**
 * Releases of the CLI the Agent SDK runtime is known to have trouble with.
 * None today; `TAU_VERSION_POLICY` may name some before a release does.
 */
export const CLAUDE_CODE_VERSION_POLICY: VersionPolicy = { ranges: [] };

/** Claude gets only skill metadata from the host's skill catalog; it never sees Pi's resource loader. */
export function claudeComposerCommands(
  skills: readonly { name: string; description?: string }[],
  adapter: ClaudeCodeAgentRuntimeAdapter,
): UiComposerCommand[] {
  return skills
    .filter((skill) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(skill.name))
    .map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill" as const,
      skillCommand: skillInvocationCommand(skill.name, adapter),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export const CLAUDE_COMMAND_VARIABLE = "TAU_CLAUDE_CODE_COMMAND";

/** The CLI signs in only in a terminal: its login is an interactive page with a code to paste back. */
export const CLAUDE_SIGN_IN_METHODS: readonly SignInMethod[] = [
  { id: "plan", label: "Sign in with a Claude plan", kind: "terminal", description: "Runs claude auth login in a terminal you can see; it opens Anthropic's page in your browser." },
  { id: "console", label: "Sign in with an Anthropic Console account", kind: "terminal", description: "Billed per token to the Console organization; runs claude auth login --console." },
];

/** A missing CLI fails with an explanation instead of a bare ENOENT from the first turn. */
export function assertCommandInstalled(findCommand: (name: string) => string | undefined, command = process.env[CLAUDE_COMMAND_VARIABLE] ?? "claude"): void {
  if (findCommand(command)) return;
  throw new Error(`The Claude Code CLI "${command}" was not found on the PATH of your login shell. Install it (https://claude.ai/code) or set its path under Settings → Providers.`);
}

function instanceInput(input: unknown): string {
  const id = (input as { instance?: unknown } | undefined)?.instance;
  return typeof id === "string" && id ? id : DEFAULT_INSTANCE_ID;
}

/**
 * The Agent SDK runtime as a runtime backend (ADR 0005): threads it owns drive
 * the installed CLI through the Agent SDK and persist in Tau's app data. Each
 * instance — the default one and any the user adds on the Providers page,
 * with its own executable, home (`CLAUDE_CONFIG_DIR`), environment and
 * launch options — registers a backend of its own, so a thread keeps it.
 * Bundled by default; removing the extension leaves Pi as the only backend.
 */
export function createClaudeCodeHostExtension(options: ClaudeCodeHostExtensionOptions = {}): HostExtension {
  return {
    id: CLAUDE_CODE_HOST_EXTENSION_ID,
    name: "Claude Code",
    permissions: ["process", "sessions", "runtime:extend", "network"],
    activate(context) {
      const services: HostExtensionServices = context.services;
      const env = options.env ?? process.env;
      const storePath = ClaudeRuntimeSessionStore.defaultPath(options.sessionsDir ?? services.sessionsDir);
      const store = options.adapter?.sessionStore ?? new ClaudeRuntimeSessionStore({ filePath: storePath });
      const readVersion = options.readVersion ?? readClaudeVersion;
      const settings = new RuntimeInstanceSettings({
        file: join(services.stateDir, "settings.json"),
        driver: CLAUDE_CODE_BACKEND_KIND,
        label: "Claude Code",
        executable: "claude",
        commandVariable: CLAUDE_COMMAND_VARIABLE,
        homeVariable: CLAUDE_HOME_VARIABLE,
        env,
      });
      const policy = runtimeVersionPolicy(CLAUDE_CODE_BACKEND_KIND, CLAUDE_CODE_VERSION_POLICY, env);
      /** What the CLI says about its login; undefined when it is missing or cannot say. */
      const authOf = async (id: string): Promise<ClaudeAuthStatus | undefined> => {
        const path = services.findCommand(settings.command(id).command);
        if (!path) return undefined;
        services.noteSubprocess();
        return (options.readAuth ?? readClaudeAuth)(path, settings.environment(id, env)).catch(() => undefined);
      };
      const claudeCommand = (id: string): string => settings.command(id).command;
      const unregisters = new Map<string, () => void>();
      const adapters = new Map<string, ClaudeCodeAgentRuntimeAdapter>();

      const adapterFor = (id: string): ClaudeCodeAgentRuntimeAdapter => {
        if (id === DEFAULT_INSTANCE_ID && options.adapter) return options.adapter;
        const runtime: ClaudeCodeRuntimeOptions = {
          id: settings.kind(id),
          storePath,
          sessionStore: store,
          command: () => claudeCommand(id),
          resolveCommand: services.findCommand,
          env: settings.environment(id, env),
          extraArgs: sdkExtraArgs(settings.args(id)).extraArgs,
        };
        return (options.createAdapter ?? createClaudeCodeRuntimeAdapter)(runtime);
      };
      const adapterOf = (id: string): ClaudeCodeAgentRuntimeAdapter => {
        const adapter = adapters.get(id);
        if (!adapter) throw new HostCommandError(`Claude Code has no instance “${id}”.`);
        return adapter;
      };

      const record = (entry: Awaited<ReturnType<ClaudeRuntimeSessionStore["list"]>>[number]): HostBackendThreadRecord => {
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
      const commands = (adapter: ClaudeCodeAgentRuntimeAdapter) => (cwd: string) => options.commands
        ? options.commands.map((command) => command.source === "skill"
          ? { ...command, skillCommand: skillInvocationCommand(command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name, adapter) }
          : command)
        : claudeComposerCommands(services.skills(cwd), adapter);

      /** How the instance's CLI is installed and what updates it; the maintenance and the version share one read. */
      const maintenanceOf = async (id: string, path: string): Promise<RuntimeToolMaintenance> => {
        const installed = await readVersion(path);
        const added = Object.fromEntries(Object.entries(settings.environment(id, {})).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        return cliMaintenance({
          tool: "claude",
          path,
          ...(installed ? { installed } : {}),
          spec: CLAUDE_PACKAGE,
          findCommand: (name) => services.findCommand(name),
          cacheFile: join(services.stateDir, "latest-version.json"),
          env,
          commandEnv: added,
          home: homedir(),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
      };
      const versionOf = async (id: string): Promise<RuntimeToolVersion | undefined> => {
        const path = services.findCommand(claudeCommand(id));
        if (!path) return undefined;
        const [maintenance, real] = await Promise.all([maintenanceOf(id, path), realpath(path).catch(() => path)]);
        const installed = maintenance.installed;
        const verdict = versionCompatibility(policy, installed);
        const install = verdict?.recommendedVersion ? packageInstallCommand(real, CLAUDE_NPM_PACKAGE, verdict.recommendedVersion) : undefined;
        // The native installer updates itself; a package manager's install is that manager's to update.
        const command = maintenance.update ? cliCommandText(maintenance.update) : packageUpdateCommand(real, CLAUDE_NPM_PACKAGE) ?? "claude update";
        return {
          tool: "claude",
          ...(installed ? { installed } : {}),
          ...(maintenance.latest ? { latest: maintenance.latest } : {}),
          updateCommand: runtimeUpdateCommand(CLAUDE_CODE_BACKEND_KIND, command, env),
          ...(verdict ? { compatibility: install ? { ...verdict, installCommand: install } : verdict } : {}),
        };
      };
      /** The program each instance's catalog was last asked of; another one is probed afresh. */
      const catalogKeys = new Map<string, string | undefined>();

      /** Per instance: the plan's windows last read or reported by a turn, and the login's billing. */
      const limits = new Map<string, { at: number; windows: LimitWindow[]; plan?: string; billing?: UiModelBilling; identity?: AccountIdentity; error?: string; unsupported?: boolean }>();
      const noteProbe = (id: string, probe: ClaudeProbe): ClaudeProbe => {
        const billing = probeBilling(probe.account);
        const held = limits.get(id);
        limits.set(id, { at: held?.at ?? 0, windows: held?.windows ?? [], ...(held?.plan ? { plan: held.plan } : {}), ...(held?.identity ? { identity: held.identity } : {}), ...(billing ? { billing } : {}) });
        return probe;
      };
      const noteRateLimits = (id: string, infos: ReadonlyArray<Record<string, unknown>>): void => {
        const updates = infos.flatMap((info) => rateLimitEventWindow(info) ?? []);
        if (updates.length === 0) return;
        const held = limits.get(id);
        limits.set(id, { ...held, at: Date.now(), windows: mergeWindows(held?.windows ?? [], updates) });
      };
      const readLimits = async (id: string, adapter: ClaudeCodeAgentRuntimeAdapter): Promise<void> => {
        try {
          const probe = noteProbe(id, await adapter.probe({ usage: true }));
          const windows = usageReadWindows(probe.usage);
          const plan = probe.account?.subscriptionType;
          const identity = probeBilling(probe.account) === "subscription" ? await readAgentSdkIdentity(settings.environment(id, env), plan) : undefined;
          const { identity: _previous, ...held } = limits.get(id) ?? {};
          limits.set(id, { ...held, at: Date.now(), windows: windows ?? [], ...(plan ? { plan } : {}), ...(identity ? { identity } : {}), ...(windows ? {} : { unsupported: true }) });
        } catch (error) {
          limits.set(id, { ...limits.get(id), at: Date.now(), windows: limits.get(id)?.windows ?? [], error: error instanceof Error ? error.message : String(error) });
        }
      };
      const limitAccount = (id: string): LimitAccount => {
        const held = limits.get(id);
        const base = { id: `${settings.kind(id)}:account`, runtime: settings.kind(id), label: settings.label(id), checkedAt: held?.at || Date.now(), ...(held?.plan ? { plan: held.plan } : {}), ...(held?.identity ? { identity: held.identity } : {}) };
        if (held && held.windows.length > 0) return { ...base, windows: held.windows };
        if (held?.error) return { ...base, windows: [], unavailable: { reason: "failed", message: held.error } };
        if (held?.billing === "api-key") return { ...base, windows: [], unavailable: { reason: "unsupported", message: "An API key or a cloud provider has no plan limits." } };
        if (held?.unsupported) return { ...base, windows: [], unavailable: { reason: "unsupported", message: "The CLI reports no plan limits for this login." } };
        return { ...base, windows: [] };
      };

      const providerFor = (id: string, adapter: ClaudeCodeAgentRuntimeAdapter): HostRuntimeBackendProvider => {
        const offered = commands(adapter);
        return {
          kind: adapter.id,
          label: settings.label(id),
          // Pi, the Agent SDK, Codex, Antigravity: the order docs/EXTENSIONS.md lists.
          order: 10,
          adapter,
          modelProvider: "anthropic",
          homeProviders: ["anthropic"],
          listThreads: async () => (await store.list(undefined, id)).map(record),
          removeThread: (threadId) => store.take(threadId),
          restoreThread: (threadId, value) => store.put(threadId, value),
          lookup: async (threadId) => {
            const entry = await store.get(threadId);
            return entry && (entry.instance ?? DEFAULT_INSTANCE_ID) === id ? record(entry) : undefined;
          },
          restrictsTools: true,
          open: async (threadId, cwd, { resume, tools }, thread) => {
            assertCommandInstalled(services.findCommand, claudeCommand(id));
            const verdict = versionCompatibility(policy, await versionOf(id).then((version) => version?.installed).catch(() => undefined));
            if (verdict?.status === "broken") throw new Error(`${verdict.message ?? "This Claude Code release does not work with Tau."}${verdict.recommendedVersion ? ` Install ${verdict.recommendedVersion}.` : ""}`);
            const backend = new ClaudeThreadRuntimeBackend(threadId, cwd, {
              adapter,
              store,
              instance: id,
              // The command catalog is resolved once at the owner boundary.
              commands: offered(cwd),
              projectName: thread.projectName,
              branch: thread.projectLabel,
              permissionLevel: thread.permissionLevel,
              ...(thread.executionPolicy ? { executionPolicy: thread.executionPolicy } : {}),
              mcpServer: (only) => services.mcp.connect({ sessionId: threadId, cwd }, only ? { tools: only } : undefined),
              ...(tools ? { tools } : {}),
              onMessage: thread.onMessage,
              onEvent: thread.onEvent,
              ask: thread.ask,
              ...(thread.priceUsage ? { priceUsage: thread.priceUsage } : {}),
              billing: () => limits.get(id)?.billing,
              onRateLimits: (infos) => noteRateLimits(id, infos),
              onResumeQuestionOff: () => context.emit(RESUME_QUESTION_OFF_EVENT, { runtime: adapter.id } satisfies ResumeQuestionOffEvent),
            });
            await backend.start(resume ? "resume" : "create");
            return backend;
          },
          composerCommands: offered,
          version: () => versionOf(id),
          maintenance: async () => {
            const path = services.findCommand(claudeCommand(id));
            return path ? maintenanceOf(id, path) : undefined;
          },
          programKey: () => executableFingerprint(services.findCommand(claudeCommand(id))),
          // The plan's models; the probe is cached a few minutes and the host keeps the answer.
          newThreadCatalog: async () => {
            const path = services.findCommand(claudeCommand(id));
            if (!path) return { models: [], thinkingLevels: {}, status: "not-installed", note: `The CLI "${claudeCommand(id)}" is not installed.` };
            const key = await executableFingerprint(path);
            const fresh = catalogKeys.has(id) && catalogKeys.get(id) !== key;
            catalogKeys.set(id, key);
            // The probe lists models signed out too; the CLI's own login state decides.
            const auth = await authOf(id);
            if (auth && !auth.loggedIn) return { models: [], thinkingLevels: {}, status: "sign-in-required", note: `${settings.label(id)} is not signed in. Sign in on its card under Settings → Providers.` };
            const catalog = probeNewThreadCatalog(noteProbe(id, await adapter.probe(fresh ? { fresh: true } : undefined)));
            const billing = authBilling(auth);
            if (!billing) return catalog;
            return { ...catalog, models: catalog.models.map((model) => model.billing ? model : { ...model, billing }), ...(catalog.model ? { model: catalog.model.billing ? catalog.model : { ...catalog.model, billing } } : {}) };
          },
        };
      };

      /** Registers the instance's backend anew, so core asks its version again and republishes. */
      const register = (id: string): void => {
        unregisters.get(id)?.();
        const adapter = adapterFor(id);
        adapters.set(id, adapter);
        unregisters.set(id, services.registerRuntimeBackend(providerFor(id, adapter)));
      };
      const unregister = (id: string): void => {
        unregisters.get(id)?.();
        unregisters.delete(id);
        adapters.delete(id);
      };

      const instancesReport = async (): Promise<ClaudeInstancesReport> => {
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
      const announce = async (): Promise<ClaudeInstancesReport> => {
        const report = await instancesReport();
        context.emit(INSTANCES_EVENT, report);
        return report;
      };

      context.registerCommand("status", async (input): Promise<ClaudeStatusReport> => {
        const id = instanceInput(input);
        adapterOf(id);
        const { command, source } = settings.command(id);
        const [version, auth] = await Promise.all([versionOf(id).catch(() => undefined), authOf(id)]);
        const account = claudeAuthAccount(auth);
        return {
          ...(auth ? { signedIn: auth.loggedIn, ...(account.label ? { account: account.label } : {}) } : {}),
          ...(version?.installed ? { version: version.installed } : {}),
          kind: settings.kind(id),
          ...(id === DEFAULT_INSTANCE_ID ? {} : { instance: id }),
          command,
          path: services.findCommand(command),
          ...(source ? { commandSource: source } : {}),
          ...(updateAvailable(version) ? { update: { installed: version.installed, latest: version.latest, command: version.updateCommand } } : {}),
          ...(version?.compatibility ? { compatibility: version.compatibility, ...(version.installed ? { installed: version.installed } : {}), ...(version.updateCommand ? { updateCommand: version.updateCommand } : {}) } : {}),
        };
      }, { access: "read" });
      context.registerCommand("instances", () => instancesReport(), { access: "read" });
      // Adds or edits an instance from the Providers page; its backend is registered anew.
      context.registerCommand("save-instance", async (input) => {
        const requested = (input as { instance?: unknown } | undefined)?.instance as RuntimeInstanceConfig | undefined;
        if (!requested || typeof requested.id !== "string") throw new HostCommandError("Name the instance to save.");
        if (requested.id === DEFAULT_INSTANCE_ID && requested.command !== settings.get(DEFAULT_INSTANCE_ID)?.command && settings.command(DEFAULT_INSTANCE_ID).source === "env") {
          throw new HostCommandError(`${CLAUDE_COMMAND_VARIABLE} is set in Tau's environment and decides the path.`);
        }
        if (requested.command && !services.findCommand(requested.command)) throw new HostCommandError(`No executable at "${requested.command}".`);
        const launch = sdkExtraArgs(splitArguments(requested.args));
        if (launch.problem) throw new HostCommandError(launch.problem);
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
        const current = settings.get(id);
        if (!current) throw new HostCommandError(`Claude Code has no instance “${id}”.`);
        const requested = typeof (input as { command?: unknown } | undefined)?.command === "string" ? (input as { command: string }).command.trim() : "";
        if (settings.command(id).source === "env") throw new HostCommandError(`${CLAUDE_COMMAND_VARIABLE} is set in Tau's environment and decides the path.`);
        if (requested && !services.findCommand(requested)) throw new HostCommandError(`No executable at "${requested}".`);
        const { command: _command, ...rest } = current;
        await settings.save({ ...rest, ...(requested ? { command: requested } : {}) });
        register(id);
        return { command: claudeCommand(id) };
      });
      // After the user ran the update command: core asks the version anew, and so does the caller.
      context.registerCommand("recheck", async (input) => {
        const id = instanceInput(input);
        adapterOf(id);
        register(id);
        return versionOf(id).catch(() => undefined);
      });
      // Asks the CLI itself (version, login, models); a process is spawned, so this is on demand.
      context.registerCommand("probe", async (input) => {
        const id = instanceInput(input);
        const adapter = adapterOf(id);
        // A CLI that will not start or is not signed in is a missing prerequisite, not a broken kit.
        const probe = await adapter.probe({ fresh: Boolean(input && typeof input === "object" && (input as { fresh?: unknown }).fresh) })
          .catch((error: unknown) => { throw new HostCommandError(error instanceof Error ? error.message : String(error)); });
        noteProbe(id, probe);
        const command = claudeCommand(id);
        return {
          // The probe learns the version only from a turn's init frame; the binary always knows it.
          version: probe.claudeCodeVersion ?? await readVersion(services.findCommand(command) ?? command),
          account: describeAccount(probe.account),
          defaultModel: probe.defaultModel,
          effort: probe.effort,
          models: probe.models,
        };
      });
      // Each thread's running total and its turns, for the Usage kit; read from the store, never from Anthropic.
      context.registerCommand("usage", async () => ({
        threads: (await store.list()).map((entry) => {
          const model = entry.observedModel ?? entry.model;
          return {
            threadId: entry.tauThreadId,
            sessionId: entry.claudeSessionId,
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
        folders: settings.list().map((instance) => {
          const billing = limits.get(instance.id)?.billing;
          return { format: "agent-sdk", path: join(claudeConfigDir(settings.environment(instance.id, env)), "projects"), instance: settings.kind(instance.id), ...(billing ? { billing } : {}) };
        }),
      }), { access: "read", callers: [USAGE_KIT_ID] });
      // What each thread said, for Search Kit to find threads nobody has open; only what it lacks.
      context.registerCommand(THREAD_TEXTS_COMMAND, async (input) => threadTextsDelta(await store.list(), input), { long: true, callers: [SEARCH_KIT_ID] });
      // The plan's windows, for the Usage kit: read through the CLI at most every few minutes, fresher when a turn reported them.
      context.registerCommand("usage-limits", async (input) => {
        const refresh = Boolean(input && typeof input === "object" && (input as { refresh?: unknown }).refresh);
        const ids = settings.list().map((instance) => instance.id).filter((id) => services.findCommand(claudeCommand(id)) && adapters.has(id));
        await Promise.all(ids.map(async (id) => {
          const held = limits.get(id);
          if (!refresh && held && held.at > 0 && !held.error && Date.now() - held.at < LIMITS_TTL_MS) return;
          await readLimits(id, adapters.get(id)!);
        }));
        return { accounts: ids.map(limitAccount) };
      }, { access: "read", long: true, callers: [USAGE_KIT_ID] });
      // Sessions the default instance's CLI ran on its own, for Onboarding to list and import as threads.
      const importDirs = () => claudeProjectDirs(settings.environment(DEFAULT_INSTANCE_ID, env));
      context.registerCommand("import-scan", async () => {
        const held = await store.claudeSessionIds();
        return { source: CLAUDE_CODE_BACKEND_KIND, ...await scanClaudeSessions(importDirs(), (id) => held.has(id)) };
      }, { long: true, callers: [ONBOARDING_KIT_ID] });
      context.registerCommand("import-sessions", async (input) => {
        const outcome = await importClaudeSessions(importDirs(), (input as { paths?: unknown } | undefined)?.paths, store);
        return { ...outcome, ...(outcome.imported.length ? { update: await services.sessions.refreshIndex() } : {}) };
      }, { long: true, callers: [ONBOARDING_KIT_ID] });

      // Signing in from the window: the CLI's own login, in a terminal the user sees.
      const signInEnv = (id: string): Record<string, string> => {
        const added = settings.environment(id, {});
        const inherited = env[CLAUDE_HOME_VARIABLE] && !added[CLAUDE_HOME_VARIABLE] ? { [CLAUDE_HOME_VARIABLE]: env[CLAUDE_HOME_VARIABLE] } : {};
        return Object.fromEntries(Object.entries({ ...inherited, ...added }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      };
      const executable = (id: string): string => {
        adapterOf(id);
        const path = services.findCommand(claudeCommand(id));
        if (!path) throw new HostCommandError(`Install the CLI first; "${claudeCommand(id)}" was not found.`);
        return path;
      };
      const signIn = registerSignIn(context, {
        defaultTarget: DEFAULT_INSTANCE_ID,
        report: async (id) => {
          adapterOf(id);
          if (!services.findCommand(claudeCommand(id))) return { methods: CLAUDE_SIGN_IN_METHODS.map((method) => ({ ...method, unavailable: `Install the CLI first; "${claudeCommand(id)}" was not found.` })), account: { signedIn: false } };
          const auth = await authOf(id);
          const home = settings.environment(id, env)[CLAUDE_HOME_VARIABLE];
          return {
            methods: [...CLAUDE_SIGN_IN_METHODS],
            account: auth ? claudeAuthAccount(auth) : { signedIn: false, detail: "This release cannot report its login; update it or run it once in a terminal." },
            note: `The CLI keeps its login in ${home ?? "its own configuration"}; Tau stores none.`,
          };
        },
        signIn: async (id, method, flow) => {
          const path = executable(id);
          flow.show({ terminal: { command: commandLine(path, ["auth", "login", method === "console" ? "--console" : "--claudeai"], signInEnv(id), process.platform) } });
          const ended = await flow.ask({ kind: "text", message: "Waiting for the login to finish in the terminal." });
          flow.verifying();
          const auth = await authOf(id);
          if (!auth?.loggedIn) throw new Error(ended === "0" || ended === "done" ? "The CLI still reports no login." : `The login ended without signing in (${ended}).`);
          return `Signed in as ${claudeAuthAccount(auth).label}.`;
        },
        signOut: async (id) => {
          const invocation = commandInvocation(executable(id), ["auth", "logout"]);
          services.noteSubprocess();
          await promisify(execFile)(invocation.command, invocation.args, { env: settings.environment(id, env), timeout: 20_000, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments });
          const after = await authOf(id);
          return after?.loggedIn ? `Signed out; the CLI still reaches a model through ${after.apiKeySource ?? after.apiProvider ?? "its environment"}.` : `Signed out of ${settings.label(id)}.`;
        },
        changed: (id) => { if (settings.get(id)) register(id); },
      });

      for (const instance of settings.list()) register(instance.id);
      return () => {
        signIn.dispose();
        for (const id of [...unregisters.keys()]) unregister(id);
      };
    },
  };
}

export default createClaudeCodeHostExtension;
