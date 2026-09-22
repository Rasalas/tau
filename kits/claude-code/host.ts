import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { HostCommandError, npmLatestVersion, packageUpdateCommand, skillInvocationCommand, updateAvailable, type HostBackendThreadRecord, type HostExtension, type HostExtensionServices, type HostRuntimeBackendProvider, type UiComposerCommand } from "tau/host-extension";
import { CommandOverride } from "./command-override.js";
import { CLAUDE_CODE_BACKEND_KIND, CLAUDE_CODE_HOST_EXTENSION_ID, USAGE_KIT_ID } from "./protocol.js";
import { describeAccount, readClaudeVersion } from "./probe.js";
import { createClaudeCodeRuntimeAdapter, type ClaudeCodeAgentRuntimeAdapter } from "./runtime-adapter.js";
import { ClaudeRuntimeSessionStore } from "./session-store.js";
import { ClaudeThreadRuntimeBackend } from "./thread-backend.js";

export { CLAUDE_CODE_BACKEND_KIND, CLAUDE_CODE_HOST_EXTENSION_ID };

export interface ClaudeCodeHostExtensionOptions {
  /** A prepared adapter (tests inject a fake transport); the CLI adapter otherwise. */
  adapter?: ClaudeCodeAgentRuntimeAdapter;
  /** The session directory the store is placed beside; `services.sessionsDir` otherwise. */
  sessionsDir?: string;
  /** Commands offered instead of the shared skill directories (tests). */
  commands?: readonly UiComposerCommand[];
  /** The npm registry, for the newest release; tests answer it. */
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
}

const CLAUDE_NPM_PACKAGE = "@anthropic-ai/claude-code";

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

/**
 * Claude Code as a runtime backend (ADR 0005): threads it owns drive the
 * installed Claude CLI through the Agent SDK and persist in Tau's app data.
 * Bundled by default; removing the extension leaves Pi as the only backend.
 */
export function createClaudeCodeHostExtension(options: ClaudeCodeHostExtensionOptions = {}): HostExtension {
  return {
    id: CLAUDE_CODE_HOST_EXTENSION_ID,
    name: "Claude Code",
    permissions: ["process", "sessions", "runtime:extend", "network"],
    activate(context) {
      const services: HostExtensionServices = context.services;
      const storePath = ClaudeRuntimeSessionStore.defaultPath(options.sessionsDir ?? services.sessionsDir);
      const override = new CommandOverride(join(services.stateDir, "settings.json"), CLAUDE_COMMAND_VARIABLE, options.env ?? process.env);
      const claudeCommand = (): string => override.current()?.command ?? "claude";
      const adapter = options.adapter ?? createClaudeCodeRuntimeAdapter({ storePath, command: claudeCommand, resolveCommand: services.findCommand });
      const store = adapter.sessionStore ?? new ClaudeRuntimeSessionStore({ filePath: storePath });
      const record = (entry: Awaited<ReturnType<ClaudeRuntimeSessionStore["list"]>>[number]): HostBackendThreadRecord => ({
        threadId: entry.tauThreadId,
        cwd: entry.cwd,
        ...(entry.title ? { title: entry.title } : {}),
        updatedAt: entry.updatedAt,
        messages: entry.messages,
      });
      const commands = (cwd: string) => options.commands
        ? options.commands.map((command) => command.source === "skill"
          ? { ...command, skillCommand: skillInvocationCommand(command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name, adapter) }
          : command)
        : claudeComposerCommands(services.skills(cwd), adapter);
      const provider: HostRuntimeBackendProvider = {
        kind: CLAUDE_CODE_BACKEND_KIND,
        label: "Claude Code",
        adapter,
        modelProvider: "anthropic",
        listThreads: async () => (await store.list()).map(record),
        lookup: async (threadId) => {
          const entry = await store.get(threadId);
          return entry ? record(entry) : undefined;
        },
        open: async (threadId, cwd, { resume }, thread) => {
          assertCommandInstalled(services.findCommand, claudeCommand());
          const backend = new ClaudeThreadRuntimeBackend(threadId, cwd, {
            adapter,
            store,
            // The command catalog is resolved once at the owner boundary.
            commands: commands(cwd),
            projectName: thread.projectName,
            branch: thread.projectLabel,
            permissionLevel: thread.permissionLevel,
            onMessage: thread.onMessage,
            onEvent: thread.onEvent,
            ask: thread.ask,
          });
          await backend.start(resume ? "resume" : "create");
          return backend;
        },
        composerCommands: commands,
        version: async () => {
          const path = services.findCommand(claudeCommand());
          if (!path) return undefined;
          const [installed, latest, real] = await Promise.all([
            readClaudeVersion(path),
            npmLatestVersion(CLAUDE_NPM_PACKAGE, { cacheFile: join(services.stateDir, "latest-version.json"), ...(options.fetch ? { fetch: options.fetch } : {}) }),
            realpath(path).catch(() => path),
          ]);
          // The native installer updates itself; a package manager's install is that manager's to update.
          return { tool: "claude", ...(installed ? { installed } : {}), ...(latest ? { latest } : {}), updateCommand: packageUpdateCommand(real, CLAUDE_NPM_PACKAGE) ?? "claude update" };
        },
      };
      context.registerCommand("status", async () => {
        const command = claudeCommand();
        const source = override.current()?.source;
        const version = await provider.version!().catch(() => undefined);
        return {
          kind: CLAUDE_CODE_BACKEND_KIND,
          command,
          path: services.findCommand(command),
          ...(source ? { commandSource: source } : {}),
          ...(updateAvailable(version) ? { update: { installed: version.installed, latest: version.latest, command: version.updateCommand } } : {}),
        };
      });
      // The executable's path from the Providers card; empty clears it.
      context.registerCommand("set-command", async (input) => {
        const requested = typeof (input as { command?: unknown } | undefined)?.command === "string" ? (input as { command: string }).command.trim() : "";
        if (override.current()?.source === "env") throw new HostCommandError(`${CLAUDE_COMMAND_VARIABLE} is set in Tau's environment and decides the path.`);
        if (requested && !services.findCommand(requested)) throw new HostCommandError(`No executable at "${requested}".`);
        await override.set(requested || undefined);
        return { command: claudeCommand() };
      });
      // Asks the CLI itself (version, login, models); a process is spawned, so this is on demand.
      context.registerCommand("probe", async (input) => {
        const probe = await adapter.probe({ fresh: Boolean(input && typeof input === "object" && (input as { fresh?: unknown }).fresh) });
        const command = claudeCommand();
        return {
          // The probe learns the version only from a turn's init frame; the binary always knows it.
          version: probe.claudeCodeVersion ?? await readClaudeVersion(services.findCommand(command) ?? command),
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
      return services.registerRuntimeBackend(provider);
    },
  };
}

export default createClaudeCodeHostExtension;
