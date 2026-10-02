import { composerCommandsForAdapter } from "./bridge-snapshot.js";
import type { HostRuntimeBackendProvider } from "./host-extensions.js";
import type { UiComposerCommand, CustomProviderInput, SystemPromptInspection, UiModel } from "../shared/contracts.js";
import { addModelProvider } from "./models-config.js";
import { discoverPromptOverrides } from "./system-prompt-resolver.js";
import type { HostPublication } from "./host-publication.js";
import type { ThreadRuntime } from "./thread-runtime.js";

/** A provider edit becomes visible only after the host's model catalog is republished. */
export async function configureHostModelProvider(agentDir: string, input: CustomProviderInput, publication: HostPublication): Promise<UiModel[]> {
  await addModelProvider(agentDir, input);
  publication.invalidateModels();
  await publication.publishActiveCatalog();
  return publication.ensureModels();
}

/** A runtime inspects its own prompt; an idle project reports the configuration on disk. */
export async function inspectHostSystemPrompt(thread: ThreadRuntime | undefined, fallbackCwd: string, agentDir: string, requestedCwd?: string): Promise<SystemPromptInspection> {
  if (thread?.backend.capabilities.systemPrompt) return thread.backend.capabilities.systemPrompt.inspect();
  const overrides = discoverPromptOverrides(requestedCwd || thread?.cwd || fallbackCwd, agentDir);
  return {
    effectivePrompt: overrides.customPrompt?.content ?? "(No active thread — showing project configuration)",
    ...(overrides.customPrompt ? { basePrompt: overrides.customPrompt.content, basePromptSource: overrides.customPrompt.path } : {}),
    appends: overrides.appendPrompts.map((prompt) => ({ text: prompt.content, source: prompt.path })),
    contextFiles: overrides.contextFiles,
  };
}

/** Configured commands use the runtime's dialect; otherwise its own catalog supplies them. */
export function configuredComposerCommands(provider: HostRuntimeBackendProvider, commands: readonly UiComposerCommand[], cwd: string): UiComposerCommand[] {
  return commands.length > 0 ? composerCommandsForAdapter(commands, provider.adapter) : provider.composerCommands(cwd);
}
