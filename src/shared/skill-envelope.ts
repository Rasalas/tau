/**
 * The one structural parser shared by host normalization and correlation.
 *
 * It intentionally knows only Pi's expanded envelope shape and the visible
 * suffix. Runtime dialects, skill bodies, and filesystem locations stay in the
 * host/runtime layer. A known-skill set is required before a shorthand is
 * classified; unknown `/skill:...` text remains ordinary user content.
 */

export interface ParsedSkillEnvelope {
  /** The first skill of the run. */
  name: string;
  /** Every skill of the run in order, without repeats; `name` is the first. */
  names: string[];
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

function parseOneEnvelope(raw: string): { name: string; userMessage: string } | undefined {
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
        return { name: opening.name, userMessage: stripEnvelopeSeparator(text.slice(current.next)) };
      }
    }
    if (current.next === text.length) break;
    cursor = current.next;
  }
  return undefined;
}

/**
 * Parses a complete top-level envelope without interpreting fenced lookalikes.
 * A run of envelopes (one per skill of a message) is read as one; with
 * `isKnown`, the run stops at the first skill that is not.
 */
export function parseSkillEnvelope(raw: string, isKnown?: (name: string) => boolean): ParsedSkillEnvelope | undefined {
  const first = parseOneEnvelope(raw);
  if (!first) return undefined;
  const names = [first.name];
  let userMessage = first.userMessage;
  for (;;) {
    const next = parseOneEnvelope(userMessage);
    if (!next || (isKnown && !isKnown(next.name))) break;
    if (!names.includes(next.name)) names.push(next.name);
    userMessage = next.userMessage;
  }
  return { name: first.name, names, userMessage, envelope: true };
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

export interface SkillRunOptions {
  /** Read a run of skill tokens (`$a $b text`), not only the first; for runtimes that load every one. */
  multiple?: boolean;
}

/** Reads the leading `$name`, `/name` or `/skill:name` tokens `accept` allows, one delimiter apart. */
function readSkillRun(
  raw: string,
  accept: (name: string, marker: string, token: string) => boolean,
  multiple: boolean,
): ParsedSkillEnvelope | undefined {
  const names: string[] = [];
  let offset = /^ {0,3}/u.exec(raw)![0].length;
  let end = -1;
  for (;;) {
    const match = /^([$/])([^\s]+)(?=[ \t\r\n]|$)/u.exec(raw.slice(offset));
    const name = match && shorthandName(match[2]!);
    if (!match || !name || !accept(name, match[1]!, match[2]!)) break;
    if (!names.includes(name)) names.push(name);
    end = offset + match[0].length;
    if (!multiple || !/^[ \t]/u.test(raw.slice(end))) break;
    offset = end + 1;
  }
  if (end < 0) return undefined;
  return { name: names[0]!, names, userMessage: instructionAfterToken(raw, end), envelope: false };
}

/** Parses known `$name`, `/name`, or `/skill:name` tokens at the start of text. */
export function parseKnownSkillReference(
  raw: string,
  commands: readonly { name: string; source: string }[],
  options: SkillRunOptions = {},
): ParsedSkillEnvelope | undefined {
  const known = knownSkillNames(commands);
  return readSkillRun(raw, (name, marker, token) => known.has(name)
    && !(marker === "/" && !token.startsWith("skill:") && commands.some((command) => command.source !== "skill" && command.name === name)), options.multiple === true);
}

/** Lightweight variant for correlation callers that only have names. */
export function parseKnownSkillName(
  raw: string,
  names: Iterable<string>,
  options: SkillRunOptions = {},
): ParsedSkillEnvelope | undefined {
  const known = new Set(names);
  return readSkillRun(raw, (name) => known.has(name), options.multiple === true);
}

/**
 * The tokens of a skill selection the composer made: the leading run of
 * `names`, whatever the command spelling, and the text after it. Unlike the
 * parsers above it accepts a name an extension also uses, because the user
 * chose that skill.
 */
export function parseSelectedSkillRun(raw: string, names: ReadonlySet<string>): ParsedSkillEnvelope | undefined {
  return readSkillRun(raw, (name) => names.has(name), true);
}

/** Shared parser used by both normalization and runtime correlation. */
export function parseKnownSkillInvocation(
  raw: string,
  commands: readonly { name: string; source: string }[],
  options: SkillRunOptions = {},
): ParsedSkillEnvelope | undefined {
  const known = knownSkillNames(commands);
  const envelope = parseSkillEnvelope(raw, (name) => known.has(name));
  if (envelope) return known.has(envelope.name) ? envelope : undefined;
  return parseKnownSkillReference(raw, commands, options);
}

/** Returns the visible suffix only for complete envelopes. */
export function visibleSkillEnvelopeText(raw: string): string | undefined {
  return parseSkillEnvelope(raw)?.userMessage;
}
