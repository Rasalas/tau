import type { PreparedPrompt, RuntimeCapabilities, ThreadBackendKind, UiComposerCommand, UiSkillDraft, UiSkillInvocation } from "./contracts.js";
import { clientMessageFingerprint } from "./client-message-correlation.js";
import { isSkillName, knownSkillNames, parseKnownSkillInvocation, parseSelectedSkillRun } from "./skill-envelope.js";

export interface PreparedPromptValidationContext {
  backendKind: ThreadBackendKind;
  threadId?: string;
  providerSessionId?: string;
  runtimeCapabilities: RuntimeCapabilities;
  commands: readonly UiComposerCommand[];
}

export function canonicalPreparedSkillName(name: string): string {
  return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

export function runtimeSkillCommand(name: string, capabilities: RuntimeCapabilities): string {
  return capabilities.skillInvocationDialect === "pi" ? `/skill:${name}` : `/${name}`;
}

interface SkillHolder {
  skill?: UiSkillInvocation | undefined;
  skills?: readonly UiSkillInvocation[] | undefined;
}

/** The skill fields of a prepared prompt or a message, as spread into the object that carries them. */
export function skillFields(holder: SkillHolder): { skill?: UiSkillInvocation; skills?: UiSkillInvocation[] } {
  return {
    ...(holder.skill ? { skill: holder.skill } : {}),
    ...(holder.skills ? { skills: [...holder.skills] } : {}),
  };
}

/** Every skill of a message in order; a client that predates `skills` still shows `skill`. */
export function messageSkills(holder: SkillHolder): readonly UiSkillInvocation[] {
  return holder.skills ?? (holder.skill ? [holder.skill] : []);
}

/** The selection a prepared prompt came from, to prepare it again for another thread. */
export function skillDraftOf(holder: SkillHolder, visibleText: string): UiSkillDraft | undefined {
  const [first, ...more] = messageSkills(holder);
  if (!first) return undefined;
  return {
    source: "skill",
    name: first.name,
    visibleText,
    command: first.command,
    ...(more.length > 0 ? { additionalSkills: more.map(({ name, command }) => ({ name, command })) } : {}),
  };
}

function isSkill(value: unknown): value is UiSkillInvocation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === "string"
    && typeof candidate.command === "string"
    && typeof candidate.copyText === "string";
}

function selectedSkillVisibleText(
  text: string,
  names: readonly string[],
  commands: readonly UiComposerCommand[],
  multiple: boolean,
): string | undefined {
  const parsed = parseKnownSkillInvocation(text, commands, { multiple });
  if (parsed && parsed.names.length === names.length && names.every((name) => parsed.names.includes(name))) return parsed.userMessage;
  // An explicitly selected skill remains authoritative even when an extension
  // or prompt owns the same slash spelling. Validate the tokens and suffix
  // directly, without allowing an unrelated command to claim the selection.
  const run = parseSelectedSkillRun(text, new Set(names));
  if (!multiple && (!run || names.length > 1)) return undefined;
  // Skills named further into the text lead nothing, but the text must name them.
  const visible = run ? run.userMessage : text;
  const mentioned = (name: string) => new RegExp(`(?:^|\\s)[$/](?:skill:)?${name}(?=\\s|$)`, "u").test(visible);
  return names.filter((name) => !run?.names.includes(name)).every(mentioned) ? visible : undefined;
}

/**
 * The single trust boundary for host/bridge/backend prepared prompts. Runtime
 * text is accepted only when its typed owner, dialect, skill catalog entry,
 * visible projection, and correlation proof all agree.
 */
export function validatePreparedPrompt(
  text: string,
  prepared: unknown,
  context: PreparedPromptValidationContext,
): asserts prepared is PreparedPrompt {
  if (!prepared || typeof prepared !== "object") throw new Error("Received an invalid prepared prompt.");
  const candidate = prepared as Partial<PreparedPrompt>;
  const tauThreadId = candidate.tauThreadId;
  if (candidate.backendKind !== context.backendKind
    || (tauThreadId !== undefined && tauThreadId !== context.threadId)
    || (candidate.sessionId !== undefined && candidate.sessionId !== context.threadId)
    || (candidate.providerSessionId !== undefined && candidate.providerSessionId !== context.providerSessionId)
    || candidate.runtimeCapabilities?.skillInvocationDialect !== context.runtimeCapabilities.skillInvocationDialect
    || typeof candidate.visibleText !== "string"
    || typeof candidate.runtimeText !== "string"
    || typeof candidate.sourceFingerprint !== "string") {
    throw new Error("Prepared prompt belongs to another runtime.");
  }

  const names = knownSkillNames(context.commands);
  const multiple = context.runtimeCapabilities.multipleSkills === true;
  if (candidate.skill !== undefined) {
    const listed = candidate.skills ?? [candidate.skill];
    if (!isSkill(candidate.skill) || !listed.every(isSkill) || listed[0] !== candidate.skill && JSON.stringify(listed[0]) !== JSON.stringify(candidate.skill)) {
      throw new Error("Prepared prompt contains invalid skill metadata.");
    }
    const selected = listed.map((entry) => canonicalPreparedSkillName(entry.name));
    const unavailable = () => new Error("Prepared prompt contains an unavailable skill.");
    if (new Set(selected).size !== selected.length || (selected.length > 1 && !multiple) || (candidate.skills !== undefined && selected.length < 2)) throw unavailable();
    const expectedCommands = selected.map((name) => runtimeSkillCommand(name, context.runtimeCapabilities));
    for (const [index, name] of selected.entries()) {
      const catalogEntry = context.commands.find((command) => command.source === "skill" && canonicalPreparedSkillName(command.name) === name);
      if (!isSkillName(name)
        || !names.has(name)
        || !catalogEntry
        || listed[index]!.name !== name
        || listed[index]!.command !== expectedCommands[index]
        || (catalogEntry.skillCommand !== undefined && catalogEntry.skillCommand !== expectedCommands[index])) {
        throw unavailable();
      }
    }
    const selectedText = selectedSkillVisibleText(text, selected, context.commands, multiple);
    const copyText = candidate.visibleText ? `${expectedCommands.join(" ")} ${candidate.visibleText}` : expectedCommands.join(" ");
    if (selectedText !== candidate.visibleText
      || !listed.every((entry) => entry.copyText === copyText)
      || candidate.runtimeText !== copyText) {
      throw unavailable();
    }
  } else if (candidate.skills !== undefined || candidate.visibleText !== text || candidate.runtimeText !== text) {
    throw new Error("Prepared prompt no longer matches the message being sent.");
  }

  if (candidate.sourceFingerprint !== clientMessageFingerprint(text, [...names])) {
    throw new Error("Prepared prompt no longer matches the message being sent.");
  }
}
