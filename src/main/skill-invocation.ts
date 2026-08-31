import type {
  RuntimeCapabilities,
  SkillInvocationDialect,
  UiComposerCommand,
  UiSkillInvocation,
} from "../shared/contracts.js";
import { parseKnownSkillInvocation } from "../shared/skill-envelope.js";

export { visibleSkillEnvelopeText } from "../shared/skill-envelope.js";

/** Capability seam for runtimes that own prompt expansion. */
export interface SkillRuntimeAdapter {
  readonly capabilities: RuntimeCapabilities;
}

/** The embedded Pi runtime is the default adapter. */
export const PI_RUNTIME_ADAPTER = {
  capabilities: { skillInvocationDialect: "pi" },
} as const satisfies SkillRuntimeAdapter;

function formatSkillInvocation(name: string, userMessage: string, dialect: SkillInvocationDialect): string {
  const command = dialect === "claude-code" ? `/${name}` : `/skill:${name}`;
  return userMessage ? `${command} ${userMessage}` : command;
}

/** Runtime-owned spelling exposed to the composer as typed command metadata. */
export function skillInvocationCommand(name: string, adapter: SkillRuntimeAdapter): string {
  return formatSkillInvocation(name, "", adapter.capabilities.skillInvocationDialect);
}

export function canonicalSkillName(name: string): string {
  return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

export interface PreparedSkillPrompt {
  text: string;
  runtimeText: string;
  skill?: UiSkillInvocation;
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
): PreparedSkillPrompt {
  const invocation = parseKnownSkillInvocation(raw, commands);
  if (!invocation) return { text: raw, runtimeText: raw };
  const dialect = adapter.capabilities.skillInvocationDialect;
  const skill: UiSkillInvocation = {
    name: invocation.name,
    command: skillInvocationCommand(invocation.name, adapter),
    copyText: formatSkillInvocation(invocation.name, invocation.userMessage, dialect),
  };
  return {
    text: invocation.userMessage,
    runtimeText: skill.copyText,
    skill,
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
}

/** Produce the renderer-safe message shape without leaking injected body or local origin. */
export function skillMessagePresentation(
  raw: string,
  adapter: SkillRuntimeAdapter,
  commands: readonly UiComposerCommand[],
): SkillMessagePresentation | undefined {
  const prepared = prepareSkillPrompt(raw, adapter, commands);
  return prepared.skill ? { text: prepared.text, skill: prepared.skill } : undefined;
}
