import { getAgentDir, loadSkills, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { UiComposerCommand } from "../shared/contracts.js";
import { skillInvocationCommand, type SkillRuntimeAdapter } from "./skill-invocation.js";

/**
 * What the embedded runtime's composer lists for a project no thread of it is
 * open in: the host's own commands and the skills that project (and the user's
 * own folders) offer, found the way a thread's loader finds them.
 */
export function piWorkspaceCommands(
  base: readonly UiComposerCommand[],
  cwd: string,
  adapter: SkillRuntimeAdapter,
): UiComposerCommand[] {
  const agentDir = getAgentDir();
  const skills: UiComposerCommand[] = SettingsManager.create(cwd, agentDir).getEnableSkillCommands()
    ? loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true }).skills.map((skill) => ({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill" as const,
      skillCommand: skillInvocationCommand(skill.name, adapter),
    }))
    : [];
  return [...base.filter((command) => command.source !== "skill"), ...skills]
    .sort((left, right) => left.name.localeCompare(right.name));
}
