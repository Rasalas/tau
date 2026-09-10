/** How long a headline may get before it is cut at a word boundary. */
const HEADLINE_LIMIT = 200;

/** `400 {"type":…}` — a status and a JSON body, the shape a provider failure arrives in. */
const STATUS_PAYLOAD = /^(\d{3})\s*[:\s]\s*(\{[\s\S]*\})$/;
const PAYLOAD = /^\{[\s\S]*\}$/;

/** The keys a payload's own words hide behind, in the order they are worth trusting. */
const MESSAGE_KEYS = ["message", "error", "detail", "detailMessage", "errorMessage"];

/**
 * What a notice reads as, when the text it arrived with is the wrong thing to
 * read. A provider failure reaches Tau the way the runtime wrote it —
 * `400 {"type":"MissingSessionID","message":"Error from provider (Console Go):
 * …"}` — which is exactly what the copy button should hand over and exactly
 * what nobody wants to read in 220 px. The headline unwraps that payload to
 * the sentence inside it, keeps the status code, and shortens anything that
 * still runs long. Nothing is lost: the full text is what gets copied.
 */
export function noticeHeadline(message: string): string {
  const text = message.trim();
  const status = STATUS_PAYLOAD.exec(text);
  const body = status ? status[2] : PAYLOAD.test(text) ? text : undefined;
  const inner = body ? payloadMessage(body) : undefined;
  if (inner) return shorten(status ? `${status[1]} · ${inner}` : inner);
  return shorten(text);
}

/** The words inside a JSON payload, or nothing when it carries none. */
function payloadMessage(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // A truncated body is still worth reading as its own text; the caller
    // falls back to the raw message and the copy button keeps every character.
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const record = parsed as Record<string, unknown>;
  for (const key of MESSAGE_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** One line, collapsed and cut at a word boundary, for a note that auto-hides. */
function shorten(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= HEADLINE_LIMIT) return flat;
  const cut = flat.slice(0, HEADLINE_LIMIT);
  const lastSpace = cut.lastIndexOf(" ");
  const kept = lastSpace > HEADLINE_LIMIT / 2 ? cut.slice(0, lastSpace) : cut;
  return `${kept.trimEnd()}…`;
}
