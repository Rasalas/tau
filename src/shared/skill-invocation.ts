import type { UiComposerCommand } from "./contracts.js";

/** The two invocation dialects Tau currently needs to bridge. */
export type SkillInvocationProvider = "claude-code" | "pi";

export interface ParsedSkillEnvelope {
  kind: "expanded";
  /** The skill identifier from the Pi envelope. */
  name: string;
  /** The local origin reported by Pi. It is intentionally never displayed. */
  location: string;
  /** The injected skill document between the wrapper tags. */
  body: string;
  /** The instruction written after the closing wrapper, if there is one. */
  userMessage: string;
  /** The original message, retained so callers can fall back without loss. */
  raw: string;
}

export interface ParsedSkillReference {
  kind: "reference";
  name: string;
  syntax: "slash" | "dollar" | "pi";
  /** Text after the shorthand, without the separator immediately after it. */
  userMessage: string;
  raw: string;
}

export type ParsedSkillInvocation = ParsedSkillEnvelope | ParsedSkillReference;

type SkillCommand = UiComposerCommand | string;

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const CLAUDE_CODE_PROVIDERS = new Set([
  "claude",
  "claude-code",
  "claudecode",
]);

function decodeAttribute(value: string): string {
  // Pi currently writes filesystem paths without entities. Decoding the small
  // set used by XML/HTML attributes makes the parser tolerant of future
  // serializers without accepting arbitrary markup.
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
  const tag = text.slice(0, end + 1);
  const attributes = tag.slice("<skill".length, -1);
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
  const expression = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`, "u");
  return expression.test(line);
}

function lineEnd(text: string, start: number): { end: number; next: number } {
  const newline = text.indexOf("\n", start);
  if (newline < 0) return { end: text.length, next: text.length };
  return { end: newline > start && text[newline - 1] === "\r" ? newline - 1 : newline, next: newline + 1 };
}

function stripEnvelopeSeparator(text: string): string {
  // Pi emits two newlines after </skill>. Accept one as well, while leaving
  // additional blank lines in the user's Markdown untouched.
  const separator = /^(?:\r?\n){1,2}/u.exec(text)?.[0];
  return separator ? text.slice(separator.length) : text;
}

/**
 * Parses Pi's expanded skill message only when the wrapper is the complete
 * first line. This deliberately rejects indented/fenced lookalikes and any
 * malformed wrapper so callers can render the original text verbatim.
 */
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
      // Do not accept indentation here. A literal </skill> in prose/code is
      // not the top-level envelope terminator.
      else if (/^<\/skill>[ \t]*$/u.test(line)) {
        const body = text.slice(openingLine.next, cursor);
        const remainder = text.slice(current.next);
        return {
          kind: "expanded",
          name: opening.name,
          location: opening.location,
          body,
          userMessage: stripEnvelopeSeparator(remainder),
          raw,
        };
      }
    }
    if (current.next === text.length) break;
    cursor = current.next;
  }
  return undefined;
}

/** Compatibility name used by Pi's own skill parser. */
export const parseSkillBlock = parseSkillEnvelope;

function normalizedProvider(provider?: string): SkillInvocationProvider {
  const value = provider?.trim().toLowerCase().replaceAll("_", "-").replace(/[ \t]+/gu, "-") ?? "";
  return CLAUDE_CODE_PROVIDERS.has(value) ? "claude-code" : "pi";
}

export function skillProviderSyntax(provider?: string): SkillInvocationProvider {
  return normalizedProvider(provider);
}

function commandSkillName(command: SkillCommand): string | undefined {
  if (typeof command === "string") {
    const name = command.startsWith("skill:") ? command.slice("skill:".length) : command;
    return SKILL_NAME.test(name) ? name : undefined;
  }
  if (command.source !== "skill") return undefined;
  const name = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
  return SKILL_NAME.test(name) ? name : undefined;
}

function knownSkillNames(commands: readonly SkillCommand[] = []): Set<string> {
  return new Set(commands.flatMap((command) => {
    const name = commandSkillName(command);
    return name ? [name] : [];
  }));
}

function instructionAfterToken(text: string, end: number): string {
  const suffix = text.slice(end);
  // Consume only the separator itself. Keeping any further whitespace retains
  // intentional Markdown indentation in the instruction.
  return /^[ \t]/u.test(suffix) ? suffix.slice(1) : suffix;
}

function invocationName(token: string): { name: string; syntax: "slash" | "dollar" | "pi" } | undefined {
  if (!token) return undefined;
  if (token.startsWith("skill:")) {
    const name = token.slice("skill:".length);
    return SKILL_NAME.test(name) ? { name, syntax: "pi" } : undefined;
  }
  return undefined;
}

/** Parses a known shorthand at the start of a user message. */
export function parseSkillReference(raw: string, commands: readonly SkillCommand[] = []): ParsedSkillReference | undefined {
  // Four leading spaces are a Markdown indented code block. Fenced blocks and
  // prose before a command do not match this start-anchored expression.
  const match = /^( {0,3})([$/])([^\s]+)(?=[ \t\r\n]|$)/u.exec(raw);
  if (!match) return undefined;
  const token = match[3];
  const parsedName = token.startsWith("skill:")
    ? invocationName(token)
    : SKILL_NAME.test(token) ? { name: token, syntax: match[2] === "$" ? "dollar" as const : "slash" as const } : undefined;
  if (!parsedName) return undefined;
  const names = knownSkillNames(commands);
  if (!names.has(parsedName.name)) return undefined;
  if (match[2] === "/" && !token.startsWith("skill:") && commands.some((command) => {
    if (typeof command === "string") return false;
    return command.source !== "skill" && command.name === parsedName.name;
  })) return undefined;
  return {
    kind: "reference",
    name: parsedName.name,
    syntax: parsedName.syntax,
    userMessage: instructionAfterToken(raw, match[0].length),
    raw,
  };
}

/** Parses either an expanded envelope or a known shorthand invocation. */
export function parseSkillInvocation(raw: string, commands: readonly SkillCommand[] = []): ParsedSkillInvocation | undefined {
  const envelope = parseSkillEnvelope(raw);
  if (envelope) {
    return knownSkillNames(commands).has(envelope.name) ? envelope : undefined;
  }
  return parseSkillReference(raw, commands);
}

export function formatSkillInvocation(name: string, userMessage?: string, provider?: string): string;
export function formatSkillInvocation(invocation: Pick<ParsedSkillInvocation, "name" | "userMessage">, provider?: string): string;
export function formatSkillInvocation(
  nameOrInvocation: string | Pick<ParsedSkillInvocation, "name" | "userMessage">,
  userMessageOrProvider = "",
  provider?: string,
): string {
  const name = typeof nameOrInvocation === "string" ? nameOrInvocation : nameOrInvocation.name;
  const userMessage = typeof nameOrInvocation === "string" ? userMessageOrProvider : nameOrInvocation.userMessage;
  const activeProvider = typeof nameOrInvocation === "string" ? provider : userMessageOrProvider;
  const syntax = normalizedProvider(activeProvider) === "claude-code" ? `/${name}` : `/skill:${name}`;
  return userMessage ? `${syntax} ${userMessage}` : syntax;
}

/**
 * Converts a known skill invocation to the active provider's syntax. The
 * original text is returned byte-for-byte when recognition is uncertain.
 * Both `(text, provider, commands)` and `(text, commands, provider)` are
 * accepted so host and renderer callers can remain explicit about ownership.
 */
export function normalizeSkillInvocationForProvider(
  raw: string,
  providerOrCommands?: string | readonly SkillCommand[],
  commandsOrProvider: readonly SkillCommand[] | string = [],
): string {
  const provider = typeof providerOrCommands === "string" ? providerOrCommands : typeof commandsOrProvider === "string" ? commandsOrProvider : undefined;
  const commands = Array.isArray(providerOrCommands) ? providerOrCommands : Array.isArray(commandsOrProvider) ? commandsOrProvider : [];
  const invocation = parseSkillInvocation(raw, commands);
  if (!invocation) return raw;
  return formatSkillInvocation(invocation.name, invocation.userMessage, provider);
}

/** The copy representation is the same lossless provider-aware normal form. */
export function compactSkillInvocation(
  raw: string,
  providerOrCommands?: string | readonly SkillCommand[],
  commandsOrProvider: readonly SkillCommand[] | string = [],
): string {
  return normalizeSkillInvocationForProvider(raw, providerOrCommands, commandsOrProvider);
}

// A few descriptive aliases keep the host/renderer boundary easy to discover.
export const skillInvocationForProvider = normalizeSkillInvocationForProvider;
export const compactSkillReference = compactSkillInvocation;
