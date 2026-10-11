import { readFile } from "node:fs/promises";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type { PreparedPrompt } from "../shared/contracts.js";

/** A skill as Pi's resource loader lists it. */
export interface PiSkillFile {
  name: string;
  filePath: string;
  baseDir: string;
}

/**
 * Pi expands only one leading `/skill:name`. A message that names several is
 * expanded here the way Pi does it, one block per skill ahead of the text,
 * which stays as typed. Undefined for a message with fewer than two skills.
 */
export async function expandSkills(
  prepared: Pick<PreparedPrompt, "skills" | "visibleText">,
  find: (name: string) => PiSkillFile | undefined,
): Promise<string | undefined> {
  if (!prepared.skills || prepared.skills.length < 2) return undefined;
  const blocks = await Promise.all(prepared.skills.map(async ({ name }) => {
    const skill = find(name);
    if (!skill) throw new Error(`The skill '${name}' is no longer available.`);
    const body = stripFrontmatter(await readFile(skill.filePath, "utf8").catch((error: unknown) => {
      throw new Error(`Could not load the skill '${name}': ${error instanceof Error ? error.message : String(error)}`);
    })).trim();
    return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  }));
  return prepared.visibleText ? `${blocks.join("\n\n")}\n\n${prepared.visibleText}` : blocks.join("\n\n");
}
