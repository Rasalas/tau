export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "block"; tag: string; attributes: Readonly<Record<string, string>>; body: string; complete: boolean };

/** Whether a block contribution draws in messages of this role; assistant replies when it names none. */
export function drawsBlocksFor(block: { roles?: readonly string[] }, role: "user" | "assistant"): boolean {
  return (block.roles ?? ["assistant"]).includes(role);
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/u;
/** `<tag>` or `<tag name="value" …>`; a value escapes `&`, `"` and `<` as `&amp;`, `&quot;` and `&lt;`. */
const OPEN_TAG = /^<([a-z][\w-]*)((?:\s+[a-z][\w-]*="[^"<>]*")*)>$/u;
const ATTRIBUTE = /([a-z][\w-]*)="([^"]*)"/gu;

function tagAttributes(raw: string | undefined): Readonly<Record<string, string>> {
  const attributes: Record<string, string> = {};
  for (const [, name, value] of raw?.matchAll(ATTRIBUTE) ?? []) {
    attributes[name!] = value!.replace(/&lt;/gu, "<").replace(/&quot;/gu, '"').replace(/&amp;/gu, "&");
  }
  return attributes;
}

/**
 * Splits a reply at `<tag>` … `</tag>` lines for the tags given. A tag counts
 * only on a line of its own and outside a code fence; a block whose closing
 * tag has not arrived runs to the end and is incomplete.
 */
export function splitMessageBlocks(text: string, tags: readonly string[]): MessagePart[] {
  if (tags.length === 0 || !text.includes("<")) return [{ kind: "text", text }];
  const lines = text.split("\n");
  const parts: MessagePart[] = [];
  let buffer: string[] = [];
  let open: { tag: string; attributes: Readonly<Record<string, string>>; body: string[] } | undefined;
  let fence: string | undefined;
  const flushText = () => {
    const joined = buffer.join("\n");
    if (joined.trim()) parts.push({ kind: "text", text: joined });
    buffer = [];
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (open) {
      if (trimmed === `</${open.tag}>`) {
        parts.push({ kind: "block", tag: open.tag, attributes: open.attributes, body: open.body.join("\n").trim(), complete: true });
        open = undefined;
      } else open.body.push(line);
      continue;
    }
    const marker = FENCE.exec(line)?.[1];
    if (marker) fence = fence === undefined ? marker[0] : marker[0] === fence ? undefined : fence;
    const opening = fence === undefined && !marker ? OPEN_TAG.exec(trimmed) : null;
    if (opening && tags.includes(opening[1]!)) {
      flushText();
      open = { tag: opening[1]!, attributes: tagAttributes(opening[2]), body: [] };
      continue;
    }
    buffer.push(line);
  }
  if (open) parts.push({ kind: "block", tag: open.tag, attributes: open.attributes, body: open.body.join("\n").trim(), complete: false });
  flushText();
  return parts.length > 0 ? parts : [{ kind: "text", text }];
}
