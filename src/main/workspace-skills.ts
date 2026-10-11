import { DefaultResourceLoader, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { UiComposerCommand } from "../shared/contracts.js";
import { skillInvocationCommand, type SkillRuntimeAdapter } from "./skill-invocation.js";

const FRESH_MS = 30_000;
const found = new Map<string, { at: number; skills: Promise<Array<{ name: string; description: string }>> }>();

/** The skills a thread of `cwd` would load, found by Pi's own loader (settings, packages, project folders); nothing is installed. */
function skillsOf(cwd: string, agentDir: string): Promise<Array<{ name: string; description: string }>> {
  const key = `${agentDir}\u0000${cwd}`;
  const cached = found.get(key);
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.skills;
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const skills = settingsManager.getEnableSkillCommands()
    ? (async () => {
      const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
      await loader.reload();
      return loader.getSkills().skills.map(({ name, description }) => ({ name, description }));
    })()
    : Promise.resolve([]);
  found.set(key, { at: Date.now(), skills });
  // A failure is not kept: the next ask tries again.
  skills.catch(() => found.delete(key));
  return skills;
}

/**
 * What the embedded runtime's composer lists for a project no thread of it is
 * open in: the host's own commands and the skills that project offers.
 */
export async function piWorkspaceCommands(
  base: readonly UiComposerCommand[],
  cwd: string,
  adapter: SkillRuntimeAdapter,
): Promise<UiComposerCommand[]> {
  const skills = (await skillsOf(cwd, getAgentDir())).map((skill): UiComposerCommand => ({
    name: `skill:${skill.name}`,
    description: skill.description,
    source: "skill",
    skillCommand: skillInvocationCommand(skill.name, adapter),
  }));
  return [...base.filter((command) => command.source !== "skill"), ...skills]
    .sort((left, right) => left.name.localeCompare(right.name));
}
