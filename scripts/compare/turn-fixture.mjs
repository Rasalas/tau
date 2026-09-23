// The recorded turn both apps replay (gap analysis §3.4, tier A). Synthetic and
// deterministic: the same seed always yields byte-identical events.

export const TURN_SCHEMA = "tau-compare-turn/1";
// The probe watches for these to time first text and the end of the stream.
export const FIRST_SENTINEL = "streaming path first";
export const END_SENTINEL = "Compare turn complete.";

const MODULES = [
  "src/main/pi-host.ts",
  "src/main/host-transport-socket.ts",
  "src/renderer/App.tsx",
  "src/renderer/thread-view-store.ts",
  "src/renderer/components/Markdown.tsx",
  "kits/workspace/navigation.tsx",
  "apps/server/src/orchestration/ThreadLiveEventCoalescer.ts",
  "apps/web/src/components/chat/MessagesTimeline.tsx",
];

function mix(value) {
  let mixed = value | 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

/** Command output with enough entropy that compression cannot flatten it. */
export function commandOutput(seed, targetBytes) {
  const lines = [];
  let length = 0;
  for (let index = 0; length < targetBytes; index += 1) {
    const line = `${String(index + 1).padStart(6, "0")} ${MODULES[(seed + index) % MODULES.length]}:${(mix(seed * 31 + index) % 900) + 1} `
      + `match cursor=${mix(seed + index).toString(16)} digest=${mix(seed ^ index).toString(36)}\n`;
    lines.push(line);
    length += line.length;
  }
  return lines.join("").slice(0, targetBytes);
}

function codeBlock(index) {
  const name = `step${index + 1}`;
  const body = [];
  for (let line = 0; line < 24; line += 1) {
    body.push(`  const value${line} = compute("${MODULES[(index + line) % MODULES.length]}", ${mix(index * 97 + line) % 10_000});`);
    // Blank lines inside a fence are what split a naive paragraph chunker.
    if (line % 8 === 7) body.push("");
  }
  return ["```ts", `export function ${name}(input: Input): Output {`, ...body, "  return finish(input);", "}", "```"].join("\n");
}

function table(index) {
  const rows = ["| module | before (ms) | after (ms) | change |", "| --- | ---: | ---: | --- |"];
  for (let row = 0; row < 8; row += 1) {
    const before = (mix(index * 13 + row) % 900) + 50;
    const after = Math.round(before * 0.6);
    rows.push(`| \`${MODULES[(index + row) % MODULES.length]}\` | ${before} | ${after} | -${before - after} |`);
  }
  return rows.join("\n");
}

function paragraph(index) {
  const sentences = [];
  for (let sentence = 0; sentence < 5; sentence += 1) {
    sentences.push(`Pass ${index + 1}.${sentence + 1} reviewed \`${MODULES[(index + sentence) % MODULES.length]}\` and found that the `
      + `update path touches ${mix(index + sentence) % 40} subscribers, so the fix keeps the **streaming row** isolated from the rest of the transcript.`);
  }
  return sentences.join(" ");
}

/** About `targetBytes` of Markdown with `codeBlocks` fences and a table every fifth section. */
export function answerMarkdown({ targetBytes = 150_000, codeBlocks = 20 } = {}) {
  const sections = [];
  let length = 0;
  let index = 0;
  while (length < targetBytes) {
    const parts = [`## Finding ${index + 1}`, paragraph(index), `- first: ${paragraph(index + 1).slice(0, 120)}\n- second: ${paragraph(index + 2).slice(0, 120)}`];
    if (index < codeBlocks) parts.push(codeBlock(index));
    if (index % 5 === 4) parts.push(table(index));
    parts.push(paragraph(index + 3));
    const section = parts.join("\n\n");
    sections.push(section);
    length += section.length + 2;
    index += 1;
  }
  // Every fence must exist even when the byte target is small.
  while (index < codeBlocks) sections.push(codeBlock(index++));
  return sections.join("\n\n");
}

function chunk(text, size) {
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += size) chunks.push(text.slice(offset, offset + size));
  return chunks;
}

/**
 * Builds the turn: a short intro, five small commands, one command streaming
 * `bigOutputBytes`, then the long answer. `at` is milliseconds since the turn
 * started; both replayers sleep until it, so both apps see the same cadence.
 */
export function buildTurn({
  answerBytes = 150_000,
  codeBlocks = 20,
  bigOutputBytes = 1_000_000,
  smallCommands = 5,
  textDeltaChars = 200,
  outputChunkBytes = 8_192,
  intervalMs = 16,
} = {}) {
  const events = [];
  let at = 0;
  const push = (event) => { events.push({ at, ...event }); at += intervalMs; };
  for (const delta of chunk(`I'll look at the ${FIRST_SENTINEL}, then summarize what I found.\n\n`, textDeltaChars)) push({ kind: "text", delta });
  for (let index = 0; index < smallCommands; index += 1) {
    const id = `call-small-${index + 1}`;
    push({ kind: "tool-start", id, command: `rg -n "subscribe" ${MODULES[index % MODULES.length]}` });
    push({ kind: "tool-output", id, chunk: commandOutput(index + 1, 1_000) });
    push({ kind: "tool-end", id, exitCode: 0 });
  }
  const bigId = "call-big-output";
  push({ kind: "tool-start", id: bigId, command: "npm test -- --reporter=verbose" });
  for (const piece of chunk(commandOutput(99, bigOutputBytes), outputChunkBytes)) push({ kind: "tool-output", id: bigId, chunk: piece });
  push({ kind: "tool-end", id: bigId, exitCode: 0 });
  for (const delta of chunk(answerMarkdown({ targetBytes: answerBytes, codeBlocks }), textDeltaChars)) push({ kind: "text", delta });
  // Its own delta, so no chunk boundary splits it.
  push({ kind: "text", delta: `\n\n${END_SENTINEL}` });
  return {
    schema: TURN_SCHEMA,
    prompt: "Replay the recorded comparison turn.",
    parameters: { answerBytes, codeBlocks, bigOutputBytes, smallCommands, textDeltaChars, outputChunkBytes, intervalMs },
    durationMs: at,
    events,
  };
}

/** Totals a replayer can assert against after the turn. */
export function summarizeTurn(turn) {
  const text = turn.events.filter((event) => event.kind === "text").map((event) => event.delta).join("");
  const outputBytes = turn.events.filter((event) => event.kind === "tool-output").reduce((sum, event) => sum + event.chunk.length, 0);
  return {
    events: turn.events.length,
    textBytes: text.length,
    fences: (text.match(/^```/gmu) ?? []).length / 2,
    tools: turn.events.filter((event) => event.kind === "tool-start").length,
    outputBytes,
    durationMs: turn.durationMs,
  };
}
