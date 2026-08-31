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

/** The embedded Pi runtime is the default adapter; future adapters can opt into another dialect. */
export const PI_RUNTIME_ADAPTER = {
  capabilities: { skillInvocationDialect: "pi" },
} as const satisfies SkillRuntimeAdapter;

export interface ParsedSkillEnvelope {
  kind: "expanded";
  name: string;
  location: string;
  body: string;
  userMessage: string;
  raw: string;
}

export interface ParsedSkillReference {
  kind: "reference";
  name: string;
  syntax: "slash" | "dollar" | "pi";
  userMessage: string;
  raw: string;
}

export type ParsedSkillInvocation = ParsedSkillEnvelope | ParsedSkillReference;

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
  if (boundary !== ">" && boundary !== " " && boundary !== "\t") return undefined;

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
    if (character === "\n" || character === "\r") return undefined;
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
    while (offset < attributes.length && /[ \t]/u.test(attributes[offset] ?? "")) offset += 1;
    if (offset === attributes.length) break;
    const key = /^[A-Za-z][A-Za-z0-9:_-]*/u.exec(attributes.slice(offset));
    if (!key) return undefined;
    offset += key[0].length;
    while (offset < attributes.length && /[ \t]/u.test(attributes[offset] ?? "")) offset += 1;
    if (attributes[offset] !== "=") return undefined;
    offset += 1;
    while (offset < attributes.length && /[ \t]/u.test(attributes[offset] ?? "")) offset += 1;
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
export function parseSkillEnvelope(raw: string): ParsedSkillEnvelope | undefined {
  const text = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
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
      else if (/^<\/skill>[ \t]*$/u.test(line)) {
        return {
          kind: "expanded",
          name: opening.name,
          location: opening.location,
          body: text.slice(openingLine.next, cursor),
          userMessage: stripEnvelopeSeparator(text.slice(current.next)),
          raw,
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

function invocationName(token: string): { name: string; syntax: "slash" | "dollar" | "pi" } | undefined {
  if (!token.startsWith("skill:")) return undefined;
  const name = token.slice("skill:".length);
  return SKILL_NAME.test(name) ? { name, syntax: "pi" } : undefined;
}

/** Parse a known shorthand at the beginning of a user message. */
export function parseSkillReference(raw: string, commands: readonly UiComposerCommand[]): ParsedSkillReference | undefined {
  const match = /^( {0,3})([$/])([^\s]+)(?=[ \t\r\n]|$)/u.exec(raw);
  if (!match) return undefined;
  const token = match[3];
  const parsedName = token.startsWith("skill:")
    ? invocationName(token)
    : SKILL_NAME.test(token) ? { name: token, syntax: match[2] === "$" ? "dollar" as const : "slash" as const } : undefined;
  if (!parsedName || !knownSkillNames(commands).has(parsedName.name)) return undefined;
  if (match[2] === "/" && !token.startsWith("skill:") && commands.some((command) => command.source !== "skill" && command.name === parsedName.name)) {
    return undefined;
  }
  return {
    kind: "reference",
    name: parsedName.name,
    syntax: parsedName.syntax,
    userMessage: instructionAfterToken(raw, match[0].length),
    raw,
  };
}

/** Parse a known expanded envelope or shorthand; unknown input is deliberately not classified. */
export function parseSkillInvocation(raw: string, commands: readonly UiComposerCommand[]): ParsedSkillInvocation | undefined {
  const envelope = parseSkillEnvelope(raw);
  if (envelope) return knownSkillNames(commands).has(envelope.name) ? envelope : undefined;
  return parseSkillReference(raw, commands);
}

export function formatSkillInvocation(name: string, userMessage: string, dialect: SkillInvocationDialect): string {
  const command = dialect === "claude-code" ? `/${name}` : `/skill:${name}`;
  return userMessage ? `${command} ${userMessage}` : command;
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
      command: formatSkillInvocation(invocation.name, "", dialect),
      copyText: formatSkillInvocation(invocation.name, invocation.userMessage, dialect),
    },
  };
}
