import { getAgentDir, loadSkills } from "@earendil-works/pi-coding-agent";
import type { UiComposerCommand } from "../../../shared/contracts.js";
import type { HostBackendThreadRecord, HostExtension, HostRuntimeBackendProvider } from "../../host-extensions.js";
import { skillInvocationCommand } from "../../skill-invocation.js";
import { assertClaudePermissionPolicySupported, createClaudeCodeRuntimeAdapter, runtimePermissionPolicy, type ClaudeCodeAgentRuntimeAdapter } from "./runtime-adapter.js";
import { ClaudeRuntimeSessionStore } from "./session-store.js";
import { ClaudeThreadRuntimeBackend } from "./thread-backend.js";

export const CLAUDE_CODE_HOST_EXTENSION_ID = "tau.claude-code";
export const CLAUDE_CODE_BACKEND_KIND = "claude-code";

export interface ClaudeCodeHostExtensionOptions {
  /** A prepared adapter (tests inject a fake transport); the CLI adapter otherwise. */
  adapter?: ClaudeCodeAgentRuntimeAdapter;
  agentDir?: string;
  /** Commands offered instead of the shared skill directories (tests). */
  commands?: readonly UiComposerCommand[];
}

/** Claude gets only skill metadata from the shared skill directories; it never sees Pi's resource loader. */
export function claudeComposerCommands(cwd: string, agentDir: string, adapter: ClaudeCodeAgentRuntimeAdapter): UiComposerCommand[] {
  const result = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
  return result.skills
    .filter((skill) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(skill.name))
    .map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill" as const,
      skillCommand: skillInvocationCommand(skill.name, adapter),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
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
    activate(context) {
      const agentDir = options.agentDir ?? getAgentDir();
      const adapter = options.adapter ?? createClaudeCodeRuntimeAdapter({ agentDir });
      const store = adapter.sessionStore ?? new ClaudeRuntimeSessionStore({ filePath: ClaudeRuntimeSessionStore.defaultPath(agentDir) });
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
        : claudeComposerCommands(cwd, agentDir, adapter);
      const provider: HostRuntimeBackendProvider = {
        kind: CLAUDE_CODE_BACKEND_KIND,
        adapter,
        listThreads: async () => (await store.list()).map(record),
        lookup: async (threadId) => {
          const entry = await store.get(threadId);
          return entry ? record(entry) : undefined;
        },
        open: async (threadId, cwd, { resume }, thread) => {
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
          if (resume) await backend.resume();
          else await backend.create();
          return backend;
        },
        composerCommands: commands,
        assertPromptAllowed: (level) => assertClaudePermissionPolicySupported(runtimePermissionPolicy(level)),
      };
      context.registerCommand("status", () => ({ kind: CLAUDE_CODE_BACKEND_KIND, command: process.env.TAU_CLAUDE_CODE_COMMAND ?? "claude" }));
      return context.services.registerRuntimeBackend(provider);
    },
  };
}
