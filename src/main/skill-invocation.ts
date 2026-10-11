import type { RuntimeCapabilities, SkillInvocationDialect, UiComposerCommand, UiSkillDraft, UiSkillInvocation } from "../shared/contracts.js";
import { parseKnownSkillInvocation } from "../shared/skill-envelope.js";
import { canonicalPreparedSkillName, runtimeSkillCommand, skillFields } from "../shared/prepared-prompt.js";

export { visibleSkillEnvelopeText } from "../shared/skill-envelope.js";

/** Capability seam for runtimes that own prompt expansion. */
export interface SkillRuntimeAdapter {
  readonly capabilities: RuntimeCapabilities;
}

/** The embedded Pi runtime is the default adapter. */
export const PI_RUNTIME_ADAPTER = {
  capabilities: { skillInvocationDialect: "pi" },
} as const satisfies SkillRuntimeAdapter;

/** The runtime spelling of a message: every skill's command, then the text after them. */
function formatSkillInvocation(names: readonly string[], userMessage: string, dialect: SkillInvocationDialect): string {
  const commands = names.map((name) => runtimeSkillCommand(name, { skillInvocationDialect: dialect })).join(" ");
  return userMessage ? `${commands} ${userMessage}` : commands;
}

/** Runtime-owned spelling exposed to the composer as typed command metadata. */
export function skillInvocationCommand(name: string, adapter: SkillRuntimeAdapter): string {
  return runtimeSkillCommand(name, adapter.capabilities);
}

export function canonicalSkillName(name: string): string {
  return canonicalPreparedSkillName(name);
}

export interface PreparedSkillPrompt {
  text: string;
  runtimeText: string;
  /** The first skill of the message. */
  skill?: UiSkillInvocation;
  /** Every skill, only when there are two or more. */
  skills?: UiSkillInvocation[];
}

function invocations(names: readonly string[], userMessage: string, adapter: SkillRuntimeAdapter): { skill: UiSkillInvocation; skills?: UiSkillInvocation[]; copyText: string } {
  const copyText = formatSkillInvocation(names, userMessage, adapter.capabilities.skillInvocationDialect);
  const all = names.map((name) => ({ name, command: skillInvocationCommand(name, adapter), copyText }));
  return { skill: all[0]!, ...(all.length > 1 ? { skills: all } : {}), copyText };
}

/**
 * Parses one user intent at the runtime boundary. Callers that need both the
 * visible projection and the transport spelling use this function so the
 * parser is not invoked twice with potentially different command registries.
 */
export function prepareSkillPrompt(
  raw: string,
  adapter: SkillRuntimeAdapter,
  commands: readonly UiComposerCommand[],
  selectedSkill?: UiSkillDraft,
): PreparedSkillPrompt {
  if (selectedSkill) {
    const selected = [{ name: selectedSkill.name, command: selectedSkill.command }, ...selectedSkill.additionalSkills ?? []];
    const names = selected.map((entry) => canonicalSkillName(entry.name));
    const unavailable = () => new Error(`The selected skill '${selectedSkill.name}' is no longer available in this runtime.`);
    if (selected.length > 1 && adapter.capabilities.multipleSkills !== true) {
      throw new Error("This runtime loads one skill per message.");
    }
    if (selectedSkill.source !== "skill" || typeof selectedSkill.visibleText !== "string" || new Set(names).size !== names.length) throw unavailable();
    selected.forEach((entry, index) => {
      const name = names[index]!;
      const command = skillInvocationCommand(name, adapter);
      const catalogEntry = commands.find((candidate) => candidate.source === "skill"
        && canonicalSkillName(candidate.name) === name);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name)
        || !catalogEntry
        || entry.command !== command
        || (catalogEntry.skillCommand !== undefined && catalogEntry.skillCommand !== command)) {
        throw new Error(`The selected skill '${entry.name}' is no longer available in this runtime.`);
      }
    });
    const { skill, skills, copyText } = invocations(names, selectedSkill.visibleText, adapter);
    return { text: selectedSkill.visibleText, runtimeText: copyText, skill, ...(skills ? { skills } : {}) };
  }
  const invocation = parseKnownSkillInvocation(raw, commands, { multiple: adapter.capabilities.multipleSkills === true });
  if (!invocation) return { text: raw, runtimeText: raw };
  const { skill, skills, copyText } = invocations(invocation.names, invocation.userMessage, adapter);
  return {
    text: invocation.userMessage,
    runtimeText: copyText,
    skill,
    ...(skills ? { skills } : {}),
  };
}

/** Normalize user intent at the runtime-owner boundary, preserving uncertain input byte-for-byte. */
export function normalizeSkillInvocationForRuntime(
  raw: string,
  adapter: SkillRuntimeAdapter,
  commands: readonly UiComposerCommand[],
): string {
  return prepareSkillPrompt(raw, adapter, commands).runtimeText;
}

/** Bridge-owned Pi runtime normalization, kept separate from host transport code. */
export function normalizePiBridgePrompt(raw: string, commands: readonly UiComposerCommand[]): string {
  return normalizeSkillInvocationForRuntime(raw, PI_RUNTIME_ADAPTER, commands);
}

export interface SkillMessagePresentation {
  text: string;
  skill: UiSkillInvocation;
  skills?: UiSkillInvocation[];
}

/** Produce the renderer-safe message shape without leaking injected body or local origin. */
export function skillMessagePresentation(
  raw: string,
  adapter: SkillRuntimeAdapter,
  commands: readonly UiComposerCommand[],
): SkillMessagePresentation | undefined {
  const prepared = prepareSkillPrompt(raw, adapter, commands);
  return prepared.skill ? { text: prepared.text, ...skillFields(prepared), skill: prepared.skill } : undefined;
}
