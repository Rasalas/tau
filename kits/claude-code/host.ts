import { skillInvocationCommand, type HostBackendThreadRecord, type HostExtension, type HostExtensionServices, type HostRuntimeBackendProvider, type UiComposerCommand } from "tau/host-extension";
import { CLAUDE_CODE_BACKEND_KIND, CLAUDE_CODE_HOST_EXTENSION_ID } from "./protocol.js";
import { assertClaudePermissionPolicySupported, createClaudeCodeRuntimeAdapter, runtimePermissionPolicy, type ClaudeCodeAgentRuntimeAdapter } from "./runtime-adapter.js";
import { ClaudeRuntimeSessionStore } from "./session-store.js";
import { ClaudeThreadRuntimeBackend } from "./thread-backend.js";

export { CLAUDE_CODE_BACKEND_KIND, CLAUDE_CODE_HOST_EXTENSION_ID };

export interface ClaudeCodeHostExtensionOptions {
  /** A prepared adapter (tests inject a fake transport); the CLI adapter otherwise. */
  adapter?: ClaudeCodeAgentRuntimeAdapter;
  /** Where the session store lives; `services.agentDir` otherwise. */
  agentDir?: string;
  /** Commands offered instead of the shared skill directories (tests). */
  commands?: readonly UiComposerCommand[];
}

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

const claudeCommand = () => process.env.TAU_CLAUDE_CODE_COMMAND ?? "claude";

/** A missing CLI fails with an explanation instead of a bare ENOENT from the first turn. */
export function assertCommandInstalled(findCommand: (name: string) => string | undefined): void {
  const command = claudeCommand();
  if (findCommand(command)) return;
  throw new Error(`The Claude Code CLI "${command}" was not found on the PATH of your login shell. Install it (https://claude.ai/code) or point TAU_CLAUDE_CODE_COMMAND at the executable.`);
}

/**
 * Claude Code as a runtime backend (ADR 0005): threads it owns run the Claude
 * CLI in print mode and persist in Tau's app data. Bundled by default; removing
 * the extension leaves Pi as the only backend.
 */
export function createClaudeCodeHostExtension(options: ClaudeCodeHostExtensionOptions = {}): HostExtension {
  return {
    id: CLAUDE_CODE_HOST_EXTENSION_ID,
    name: "Claude Code",
    permissions: ["process", "sessions", "runtime:extend"],
    activate(context) {
      const services: HostExtensionServices = context.services;
      const storePath = ClaudeRuntimeSessionStore.defaultPath(options.agentDir ?? services.agentDir);
      const adapter = options.adapter ?? createClaudeCodeRuntimeAdapter({ storePath });
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
        adapter,
        modelProvider: "anthropic",
        listThreads: async () => (await store.list()).map(record),
        lookup: async (threadId) => {
          const entry = await store.get(threadId);
          return entry ? record(entry) : undefined;
        },
        open: async (threadId, cwd, { resume }, thread) => {
          assertCommandInstalled(services.findCommand);
          const backend = new ClaudeThreadRuntimeBackend(threadId, cwd, {
            adapter,
            store,
            // The command catalog is resolved once at the owner boundary.
            commands: commands(cwd),
            projectName: thread.projectName,
            branch: thread.projectLabel,
            permissionLevel: thread.permissionLevel,
            onMessage: thread.onMessage,
          });
          await backend.start(resume ? "resume" : "create");
          return backend;
        },
        composerCommands: commands,
        assertPromptAllowed: (level) => assertClaudePermissionPolicySupported(runtimePermissionPolicy(level)),
      };
      context.registerCommand("status", () => {
        const command = claudeCommand();
        return { kind: CLAUDE_CODE_BACKEND_KIND, command, path: services.findCommand(command) };
      });
      return services.registerRuntimeBackend(provider);
    },
  };
}

export default createClaudeCodeHostExtension;
