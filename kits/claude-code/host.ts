import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_INSTANCE_ID,
  HostCommandError,
  RuntimeInstanceSettings,
  npmLatestVersion,
  packageInstallCommand,
  packageUpdateCommand,
  runtimeUpdateCommand,
  runtimeVersionPolicy,
  skillInvocationCommand,
  splitArguments,
  updateAvailable,
  versionCompatibility,
  type HostBackendThreadRecord,
  type HostExtension,
  type HostExtensionServices,
  type HostRuntimeBackendProvider,
  type RuntimeInstanceConfig,
  type RuntimeToolVersion,
  type UiComposerCommand,
  type VersionPolicy,
} from "tau/host-extension";
import { claudeProjectDirs, importClaudeSessions, scanClaudeSessions } from "./history-import.js";
import {
  CLAUDE_CODE_BACKEND_KIND,
  CLAUDE_CODE_HOST_EXTENSION_ID,
  CLAUDE_HOME_VARIABLE,
  INSTANCES_EVENT,
  ONBOARDING_KIT_ID,
  USAGE_KIT_ID,
  type ClaudeInstancesReport,
  type ClaudeStatusReport,
} from "./protocol.js";
import { describeAccount, probeNewThreadCatalog, readClaudeVersion } from "./probe.js";
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
}

const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";

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

      const record = (entry: Awaited<ReturnType<ClaudeRuntimeSessionStore["list"]>>[number]): HostBackendThreadRecord => ({
        threadId: entry.tauThreadId,
        cwd: entry.cwd,
        ...(entry.title ? { title: entry.title } : {}),
        updatedAt: entry.updatedAt,
        messages: entry.messages,
      });
      const commands = (adapter: ClaudeCodeAgentRuntimeAdapter) => (cwd: string) => options.commands
        ? options.commands.map((command) => command.source === "skill"
          ? { ...command, skillCommand: skillInvocationCommand(command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name, adapter) }
          : command)
        : claudeComposerCommands(services.skills(cwd), adapter);

      const versionOf = async (id: string): Promise<RuntimeToolVersion | undefined> => {
        const path = services.findCommand(claudeCommand(id));
        if (!path) return undefined;
        const [installed, latest, real] = await Promise.all([
          readVersion(path),
          npmLatestVersion(CLAUDE_NPM_PACKAGE, { cacheFile: join(services.stateDir, "latest-version.json"), ...(options.fetch ? { fetch: options.fetch } : {}) }),
          realpath(path).catch(() => path),
        ]);
        const verdict = versionCompatibility(policy, installed);
        const install = verdict?.recommendedVersion ? packageInstallCommand(real, CLAUDE_NPM_PACKAGE, verdict.recommendedVersion) : undefined;
        // The native installer updates itself; a package manager's install is that manager's to update.
        return {
          tool: "claude",
          ...(installed ? { installed } : {}),
          ...(latest ? { latest } : {}),
          updateCommand: runtimeUpdateCommand(CLAUDE_CODE_BACKEND_KIND, packageUpdateCommand(real, CLAUDE_NPM_PACKAGE) ?? "claude update", env),
          ...(verdict ? { compatibility: install ? { ...verdict, installCommand: install } : verdict } : {}),
        };
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
              mcpServer: (only) => services.mcp.connect({ sessionId: threadId, cwd }, only ? { tools: only } : undefined),
              ...(tools ? { tools } : {}),
              onMessage: thread.onMessage,
              onEvent: thread.onEvent,
              ask: thread.ask,
            });
            await backend.start(resume ? "resume" : "create");
            return backend;
          },
          composerCommands: offered,
          version: () => versionOf(id),
          // The plan's models; the probe is cached a few minutes and the host keeps the answer.
          newThreadCatalog: async () => services.findCommand(claudeCommand(id))
            ? probeNewThreadCatalog(await adapter.probe())
            : { models: [], thinkingLevels: {}, status: "not-installed", note: `The CLI "${claudeCommand(id)}" is not installed.` },
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
        const version = await versionOf(id).catch(() => undefined);
        return {
          kind: settings.kind(id),
          ...(id === DEFAULT_INSTANCE_ID ? {} : { instance: id }),
          command,
          path: services.findCommand(command),
          ...(source ? { commandSource: source } : {}),
          ...(updateAvailable(version) ? { update: { installed: version.installed, latest: version.latest, command: version.updateCommand } } : {}),
          ...(version?.compatibility ? { compatibility: version.compatibility, ...(version.installed ? { installed: version.installed } : {}), ...(version.updateCommand ? { updateCommand: version.updateCommand } : {}) } : {}),
        };
      });
      context.registerCommand("instances", () => instancesReport());
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
      // Each thread's running total, for the Usage kit; read from the store, never from Anthropic.
      context.registerCommand("usage", async () => ({
        threads: (await store.list()).map((entry) => {
          const model = entry.observedModel ?? entry.model;
          return {
            threadId: entry.tauThreadId,
            cwd: entry.cwd,
            updatedAt: entry.updatedAt,
            ...(model ? { model } : {}),
            ...(entry.usage ? { usage: { ...entry.usage } } : {}),
          };
        }),
      }), { callers: [USAGE_KIT_ID] });
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

      for (const instance of settings.list()) register(instance.id);
      return () => { for (const id of [...unregisters.keys()]) unregister(id); };
    },
  };
}

export default createClaudeCodeHostExtension;
