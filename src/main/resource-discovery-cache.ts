import type { ResourceLoader, createAgentSessionServices } from "@earendil-works/pi-coding-agent";

type ResourceLoaderOptions = NonNullable<Parameters<typeof createAgentSessionServices>[0]["resourceLoaderOptions"]>;

export interface ResourceDiscoverySnapshot {
  skills: ReturnType<ResourceLoader["getSkills"]>;
  prompts: ReturnType<ResourceLoader["getPrompts"]>;
  themes: ReturnType<ResourceLoader["getThemes"]>;
  agentsFiles: ReturnType<ResourceLoader["getAgentsFiles"]>;
  systemPrompt: string | undefined;
  appendSystemPrompt: string[];
}

/** Captures immutable discovery data. Extension runtimes are deliberately excluded. */
export function captureResourceDiscovery(loader: ResourceLoader): ResourceDiscoverySnapshot {
  const skills = loader.getSkills();
  const prompts = loader.getPrompts();
  const themes = loader.getThemes();
  const agentsFiles = loader.getAgentsFiles();
  return {
    skills: { skills: [...skills.skills], diagnostics: [...skills.diagnostics] },
    prompts: { prompts: [...prompts.prompts], diagnostics: [...prompts.diagnostics] },
    themes: { themes: [...themes.themes], diagnostics: [...themes.diagnostics] },
    agentsFiles: { agentsFiles: agentsFiles.agentsFiles.map((file) => ({ ...file })) },
    systemPrompt: loader.getSystemPrompt(),
    appendSystemPrompt: [...loader.getAppendSystemPrompt()],
  };
}

/** Skips filesystem discovery while preserving fresh extension and provider runtimes. */
export function cachedResourceOptions(snapshot: ResourceDiscoverySnapshot): ResourceLoaderOptions {
  return {
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    skillsOverride: () => ({ skills: [...snapshot.skills.skills], diagnostics: [...snapshot.skills.diagnostics] }),
    promptsOverride: () => ({ prompts: [...snapshot.prompts.prompts], diagnostics: [...snapshot.prompts.diagnostics] }),
    themesOverride: () => ({ themes: [...snapshot.themes.themes], diagnostics: [...snapshot.themes.diagnostics] }),
    agentsFilesOverride: () => ({ agentsFiles: snapshot.agentsFiles.agentsFiles.map((file) => ({ ...file })) }),
    systemPromptOverride: () => snapshot.systemPrompt,
    appendSystemPromptOverride: () => [...snapshot.appendSystemPrompt],
  };
}
