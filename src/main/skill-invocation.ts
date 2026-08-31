import type {
  RuntimeCapabilities,
  SkillInvocationDialect,
  UiComposerCommand,
  UiSkillInvocation,
} from "../shared/contracts.js";

/** Capability seam for runtimes that own prompt expansion. */
export interface SkillRuntimeAdapter {
  readonly capabilities: RuntimeCapabilities;
}

/** The embedded Pi runtime is the default adapter. */
export const PI_RUNTIME_ADAPTER = {
  capabilities: { skillInvocationDialect: "pi" },
} as const satisfies SkillRuntimeAdapter;

/*
 * These parser records are deliberately private. Only the normalized visible
 * text and typed chip metadata cross the host/renderer boundary; wrapper body,
 * location, syntax and raw input stay inside the runtime-owner parser.
 */
interface InternalSkillInvocation {
  name: string;
  userMessage: string;
}

interface SkillReferenceToken {
  name: string;
}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

function decodeAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#34;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function openingTagEnd(text: string): number | undefined {
  if (!text.startsWith("<skill")) return undefined;
  const boundary = text[6];
  if (boundary !== ">" && !/[ \t\r\n]/u.test(boundary ?? "")) return undefined;

  let quote: '"' | "'" | undefined;
  for (let index = 6; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index;
  }
  return undefined;
}

function parseOpeningTag(text: string): { end: number; name: string; location: string } | undefined {
  const end = openingTagEnd(text);
  if (end === undefined) return undefined;
  const attributes = text.slice("<skill".length, end);
  const parsed = new Map<string, string>();
  let offset = 0;

  while (offset < attributes.length) {
    while (offset < attributes.length && /[ \t\r\n]/u.test(attributes[offset] ?? "")) offset += 1;
    if (offset === attributes.length) break;
    const key = /^[A-Za-z][A-Za-z0-9:_-]*/u.exec(attributes.slice(offset));
    if (!key) return undefined;
    offset += key[0].length;
    while (offset < attributes.length && /[ \t\r\n]/u.test(attributes[offset] ?? "")) offset += 1;
    if (attributes[offset] !== "=") return undefined;
    offset += 1;
    while (offset < attributes.length && /[ \t\r\n]/u.test(attributes[offset] ?? "")) offset += 1;
    const quote = attributes[offset];
    if (quote !== '"' && quote !== "'") return undefined;
    offset += 1;
    const valueStart = offset;
    while (offset < attributes.length && attributes[offset] !== quote) offset += 1;
    if (offset === attributes.length) return undefined;
    const value = decodeAttribute(attributes.slice(valueStart, offset));
    offset += 1;
    if (parsed.has(key[0])) return undefined;
    parsed.set(key[0], value);
  }

  const name = parsed.get("name");
  const location = parsed.get("location");
  if (!name || !location || !SKILL_NAME.test(name) || !location.trim()) return undefined;
  return { end, name, location };
}

function fenceStart(line: string): { marker: "`" | "~"; length: number } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
  if (!match) return undefined;
  return { marker: match[1][0] as "`" | "~", length: match[1].length };
}

function closesFence(line: string, fence: { marker: "`" | "~"; length: number }): boolean {
  return new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`, "u").test(line);
}

function lineEnd(text: string, start: number): { end: number; next: number } {
  const newline = text.indexOf("\n", start);
  if (newline < 0) return { end: text.length, next: text.length };
  return { end: newline > start && text[newline - 1] === "\r" ? newline - 1 : newline, next: newline + 1 };
}

function stripEnvelopeSeparator(text: string): string {
  const separator = /^(?:\r?\n){1,2}/u.exec(text)?.[0];
  return separator ? text.slice(separator.length) : text;
}

/** Parse only a complete, top-level Pi expansion; malformed/fenced lookalikes return undefined. */
function parseSkillEnvelope(raw: string): InternalSkillInvocation | undefined {
  const withoutBom = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  // Allow Markdown-safe leading blank lines and up to three spaces/tabs on
  // the opening line. Four-space indentation remains a code-block fallback.
  const prefix = /^(?:(?:[ \t]{0,3})\r?\n)*[ \t]{0,3}/u.exec(withoutBom)?.[0] ?? "";
  const text = withoutBom.slice(prefix.length);
  const opening = parseOpeningTag(text);
  if (!opening) return undefined;
  const openingLine = lineEnd(text, opening.end + 1);
  if (text.slice(opening.end + 1, openingLine.end).trim()) return undefined;

  let cursor = openingLine.next;
  let fence: { marker: "`" | "~"; length: number } | undefined;
  while (cursor <= text.length) {
    const current = lineEnd(text, cursor);
    const line = text.slice(cursor, current.end);
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
    } else {
      const started = fenceStart(line);
      if (started) fence = started;
      else if (/^ {0,3}<\/skill>[ \t]*$/u.test(line)) {
        return {
          name: opening.name,
          userMessage: stripEnvelopeSeparator(text.slice(current.next)),
        };
      }
    }
    if (current.next === text.length) break;
    cursor = current.next;
  }
  return undefined;
}

function commandSkillName(command: UiComposerCommand): string | undefined {
  if (command.source !== "skill") return undefined;
  const name = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
  return SKILL_NAME.test(name) ? name : undefined;
}

function knownSkillNames(commands: readonly UiComposerCommand[]): Set<string> {
  return new Set(commands.flatMap((command) => {
    const name = commandSkillName(command);
    return name ? [name] : [];
  }));
}

function instructionAfterToken(text: string, end: number): string {
  const suffix = text.slice(end);
  return /^[ \t]/u.test(suffix) ? suffix.slice(1) : suffix;
}

function invocationName(token: string): SkillReferenceToken | undefined {
  if (!token.startsWith("skill:")) return undefined;
  const name = token.slice("skill:".length);
  return SKILL_NAME.test(name) ? { name } : undefined;
}

/** Parse a known shorthand at the beginning of a user message. */
function parseSkillReference(raw: string, commands: readonly UiComposerCommand[]): InternalSkillInvocation | undefined {
  const match = /^( {0,3})([$/])([^\s]+)(?=[ \t\r\n]|$)/u.exec(raw);
  if (!match) return undefined;
  const token = match[3];
  const parsedName = token.startsWith("skill:")
    ? invocationName(token)
    : SKILL_NAME.test(token) ? { name: token } : undefined;
  if (!parsedName || !knownSkillNames(commands).has(parsedName.name)) return undefined;
  if (match[2] === "/" && !token.startsWith("skill:") && commands.some((command) => command.source !== "skill" && command.name === parsedName.name)) {
    return undefined;
  }
  return {
    name: parsedName.name,
    userMessage: instructionAfterToken(raw, match[0].length),
  };
}

/** Parse a known expanded envelope or shorthand; unknown input is deliberately not classified. */
function parseSkillInvocation(raw: string, commands: readonly UiComposerCommand[]): InternalSkillInvocation | undefined {
  const envelope = parseSkillEnvelope(raw);
  if (envelope) return knownSkillNames(commands).has(envelope.name) ? envelope : undefined;
  return parseSkillReference(raw, commands);
}

function formatSkillInvocation(name: string, userMessage: string, dialect: SkillInvocationDialect): string {
  const command = dialect === "claude-code" ? `/${name}` : `/skill:${name}`;
  return userMessage ? `${command} ${userMessage}` : command;
}

/** Runtime-owned spelling exposed to the composer as typed command metadata. */
export function skillInvocationCommand(name: string, adapter: SkillRuntimeAdapter): string {
  return formatSkillInvocation(name, "", adapter.capabilities.skillInvocationDialect);
}

/** Normalize user intent at the runtime-owner boundary, preserving uncertain input byte-for-byte. */
export function normalizeSkillInvocationForRuntime(
  raw: string,
  adapter: SkillRuntimeAdapter,
  commands: readonly UiComposerCommand[],
): string {
  const invocation = parseSkillInvocation(raw, commands);
  return invocation
    ? formatSkillInvocation(invocation.name, invocation.userMessage, adapter.capabilities.skillInvocationDialect)
    : raw;
}

/** Bridge-owned Pi runtime normalization, kept separate from host transport code. */
export function normalizePiBridgePrompt(raw: string, commands: readonly UiComposerCommand[]): string {
  return normalizeSkillInvocationForRuntime(raw, PI_RUNTIME_ADAPTER, commands);
}

/** Structurally hide an expanded wrapper from sidebar/title seeds without classifying a skill. */
export function visibleSkillEnvelopeText(raw: string): string | undefined {
  return parseSkillEnvelope(raw)?.userMessage;
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
  const invocation = parseSkillInvocation(raw, commands);
  if (!invocation) return undefined;
  const dialect = adapter.capabilities.skillInvocationDialect;
  return {
    text: invocation.userMessage,
    skill: {
      name: invocation.name,
      command: skillInvocationCommand(invocation.name, adapter),
      copyText: formatSkillInvocation(invocation.name, invocation.userMessage, dialect),
    },
  };
}
