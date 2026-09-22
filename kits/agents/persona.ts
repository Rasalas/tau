import { PARENT_LINK_ENTRY } from "tau/host-extension";
import { AGENT_PERSONA_FIELD, type AgentAccessLevel, type AgentDefinitionSummary } from "./protocol.js";
import type { AgentDefinition } from "./definitions.js";

/** What a child's link entry keeps of the definition it was started from. */
export interface AgentPersona {
  name: string;
  file: string;
  systemPrompt: string;
  tools?: string[];
  access?: AgentAccessLevel;
}

/** Tools that change the checkout; dropped when nothing else can hold a thread to its access level. */
export const WRITING_TOOLS: ReadonlySet<string> = new Set(["edit", "write", "bash"]);

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function personaOf(definition: AgentDefinition): AgentPersona {
  return {
    name: definition.name,
    file: definition.file,
    systemPrompt: definition.systemPrompt,
    ...(definition.tools ? { tools: definition.tools } : {}),
    ...(definition.access ? { access: definition.access } : {}),
  };
}

/** The persona a thread's own link entry names, if it was started from a definition. */
export function personaFromEntries(entries: readonly unknown[]): AgentPersona | undefined {
  for (const entry of entries) {
    const item = record(entry);
    if (item.type !== "custom" || item.customType !== PARENT_LINK_ENTRY) continue;
    const persona = record(record(item.data)[AGENT_PERSONA_FIELD]);
    if (typeof persona.name !== "string" || typeof persona.systemPrompt !== "string") return undefined;
    const tools = Array.isArray(persona.tools) ? persona.tools.filter((tool): tool is string => typeof tool === "string") : undefined;
    const access = persona.access === "read-only" || persona.access === "ask" || persona.access === "full" ? persona.access : undefined;
    return {
      name: persona.name,
      file: typeof persona.file === "string" ? persona.file : "",
      systemPrompt: persona.systemPrompt,
      ...(tools ? { tools } : {}),
      ...(access ? { access } : {}),
    };
  }
  return undefined;
}

/** Appended to a persona thread's system prompt on every turn. */
export function personaSection(persona: AgentPersona): string {
  return [
    `# Agent definition: ${persona.name}`,
    "",
    `This thread was started from the agent definition "${persona.name}"${persona.file ? ` (${persona.file})` : ""}. Its instructions:`,
    "",
    persona.systemPrompt,
  ].join("\n");
}

/** Tells a thread that may spawn which definitions `tau_spawn_thread` accepts. */
export function definitionsSection(definitions: readonly AgentDefinitionSummary[]): string {
  if (definitions.length === 0) return "";
  return [
    "# Agent definitions",
    "",
    "This project defines agents in .tau/agents/. Pass one as `agent` to tau_spawn_thread to start a thread with its instructions, model and tools:",
    ...definitions.map((definition) => `- ${definition.name}: ${definition.description}`),
  ].join("\n");
}

/**
 * A runtime Tau cannot extend gets the persona as the head of its first
 * message instead of its system prompt.
 */
export function firstMessageWithPersona(persona: Pick<AgentPersona, "name" | "systemPrompt">, prompt: string): string {
  return [
    `You are working as the agent "${persona.name}". Follow these instructions for the whole thread:`,
    "",
    persona.systemPrompt,
    "",
    "---",
    "",
    prompt,
  ].join("\n");
}

/** The active tools a persona leaves a thread, from what the runtime has. */
export function personaTools(persona: AgentPersona, all: readonly string[], active: readonly string[], narrowWriting: boolean): string[] {
  const known = new Set(all);
  const wanted = persona.tools ? persona.tools.filter((tool) => known.has(tool)) : [...active];
  return narrowWriting ? wanted.filter((tool) => !WRITING_TOOLS.has(tool)) : wanted;
}

export function sameTools(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((tool) => set.has(tool));
}
