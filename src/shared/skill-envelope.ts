/**
 * The one structural parser shared by host normalization and correlation.
 *
 * It intentionally knows only Pi's expanded envelope shape and the visible
 * suffix. Runtime dialects, skill bodies, and filesystem locations stay in the
 * host/runtime layer. A known-skill set is required before a shorthand is
 * classified; unknown `/skill:...` text remains ordinary user content.
 */

export interface ParsedSkillEnvelope {
  name: string;
  userMessage: string;
  /** True when the input was an expanded runtime envelope. */
  envelope: boolean;
}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export function isSkillName(value: string): boolean {
  return SKILL_NAME.test(value);
}

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
  return match ? { marker: match[1][0] as "`" | "~", length: match[1].length } : undefined;
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

/** Parses a complete top-level envelope without interpreting fenced lookalikes. */
export function parseSkillEnvelope(raw: string): ParsedSkillEnvelope | undefined {
  const withoutBom = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
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
          envelope: true,
        };
      }
    }
    if (current.next === text.length) break;
    cursor = current.next;
  }
  return undefined;
}

function commandSkillName(command: { name: string; source: string }): string | undefined {
  if (command.source !== "skill") return undefined;
  const name = command.name.startsWith("skill:") ? command.name.slice("skill:".length) : command.name;
  return SKILL_NAME.test(name) ? name : undefined;
}

export function knownSkillNames(commands: readonly { name: string; source: string }[]): Set<string> {
  return new Set(commands.flatMap((command) => {
    const name = commandSkillName(command);
    return name ? [name] : [];
  }));
}

function instructionAfterToken(text: string, end: number): string {
  const suffix = text.slice(end);
  // Remove only the autocomplete delimiter. All subsequent line whitespace
  // belongs to the user's visible Markdown and is retained byte-for-byte.
  return /^[ \t]/u.test(suffix) ? suffix.slice(1) : suffix;
}

function shorthandName(token: string): string | undefined {
  if (token.startsWith("skill:")) {
    const name = token.slice("skill:".length);
    return SKILL_NAME.test(name) ? name : undefined;
  }
  return SKILL_NAME.test(token) ? token : undefined;
}

/** Parses a known `$name`, `/name`, or `/skill:name` at the start of text. */
export function parseKnownSkillReference(
  raw: string,
  commands: readonly { name: string; source: string }[],
): ParsedSkillEnvelope | undefined {
  const match = /^( {0,3})([$/])([^\s]+)(?=[ \t\r\n]|$)/u.exec(raw);
  if (!match) return undefined;
  const name = shorthandName(match[3]);
  const known = knownSkillNames(commands);
  if (!name || !known.has(name)) return undefined;
  if (match[2] === "/" && !match[3].startsWith("skill:") && commands.some((command) => command.source !== "skill" && command.name === name)) {
    return undefined;
  }
  return { name, userMessage: instructionAfterToken(raw, match[0].length), envelope: false };
}

/** Lightweight variant for correlation callers that only have names. */
export function parseKnownSkillName(
  raw: string,
  names: Iterable<string>,
): ParsedSkillEnvelope | undefined {
  const match = /^( {0,3})([$/])([^\s]+)(?=[ \t\r\n]|$)/u.exec(raw);
  if (!match) return undefined;
  const token = match[3];
  const name = shorthandName(token);
  const known = new Set(names);
  if (!name || !known.has(name)) return undefined;
  return { name, userMessage: instructionAfterToken(raw, match[0].length), envelope: false };
}

/** Shared parser used by both normalization and runtime correlation. */
export function parseKnownSkillInvocation(
  raw: string,
  commands: readonly { name: string; source: string }[],
): ParsedSkillEnvelope | undefined {
  const envelope = parseSkillEnvelope(raw);
  if (envelope) return knownSkillNames(commands).has(envelope.name) ? envelope : undefined;
  return parseKnownSkillReference(raw, commands);
}

/** Returns the visible suffix only for complete envelopes. */
export function visibleSkillEnvelopeText(raw: string): string | undefined {
  return parseSkillEnvelope(raw)?.userMessage;
}
