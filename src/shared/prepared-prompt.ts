import type {
  PreparedPrompt,
  RuntimeCapabilities,
  ThreadBackendKind,
  UiComposerCommand,
  UiSkillInvocation,
} from "./contracts.js";
import { clientMessageFingerprint } from "./client-message-correlation.js";
import { isSkillName, knownSkillNames, parseKnownSkillInvocation } from "./skill-envelope.js";

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
  return capabilities.skillInvocationDialect === "claude-code" ? `/${name}` : `/skill:${name}`;
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
  name: string,
  commands: readonly UiComposerCommand[],
): string | undefined {
  const parsed = parseKnownSkillInvocation(text, commands);
  if (parsed?.name === name) return parsed.userMessage;
  // An explicitly selected skill remains authoritative even when an extension
  // or prompt owns the same slash spelling. Validate the token and suffix
  // directly, without allowing an unrelated command to claim the selection.
  const token = /^( {0,3})([$/])([^\s]+)(?=[ \t\r\n]|$)/u.exec(text);
  if (!token) return undefined;
  const tokenName = token[3].startsWith("skill:") ? token[3].slice("skill:".length) : token[3];
  if (tokenName !== name) return undefined;
  const suffix = text.slice(token[0].length);
  return /^[ \t]/u.test(suffix) ? suffix.slice(1) : suffix;
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
  if (candidate.skill !== undefined) {
    if (!isSkill(candidate.skill)) throw new Error("Prepared prompt contains invalid skill metadata.");
    const name = canonicalPreparedSkillName(candidate.skill.name);
    const expectedCommand = runtimeSkillCommand(name, context.runtimeCapabilities);
    const catalogEntry = context.commands.find((command) => command.source === "skill" && canonicalPreparedSkillName(command.name) === name);
    const known = names.has(name) && Boolean(catalogEntry);
    const selectedText = selectedSkillVisibleText(text, name, context.commands);
    if (!isSkillName(name)
      || !known
      || selectedText !== candidate.visibleText
      || candidate.skill.name !== name
      || candidate.skill.command !== expectedCommand
      || (catalogEntry?.skillCommand !== undefined && catalogEntry.skillCommand !== expectedCommand)
      || candidate.skill.copyText !== (candidate.visibleText ? `${expectedCommand} ${candidate.visibleText}` : expectedCommand)
      || candidate.runtimeText !== candidate.skill.copyText) {
      throw new Error("Prepared prompt contains an unavailable skill.");
    }
  } else if (candidate.visibleText !== text || candidate.runtimeText !== text) {
    throw new Error("Prepared prompt no longer matches the message being sent.");
  }

  if (candidate.sourceFingerprint !== clientMessageFingerprint(text, [...names])) {
    throw new Error("Prepared prompt no longer matches the message being sent.");
  }
}
