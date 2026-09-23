import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { HostEvent, UiToolRun } from "../shared/contracts";
import { HOST_TRANSPORT_VERSION, type HostHello, type HostPush, type HostPushEvent } from "../shared/host-transport";
import { HostPushLog, helloReply } from "../main/host-push-log.js";
import { HostPushCoalescer, type CoalescerClock } from "../main/host-push-coalescer.js";
import { startSocketHostTransport, type SocketHostTransport } from "../main/host-transport-socket.js";
import { boundedToolOutput } from "../main/host-messages.js";
import { clientToolRun, clientTranscript, liveToolOutput } from "../main/client-tool-output.js";
import { HostConnection, type HostTransport } from "./host-connection";
import { isWireEvent } from "./tool-output-stream";
import { createThreadViewState, reduceHostEvent, type ThreadViewState } from "./thread-view-store";

/**
 * The transfer budget: bytes and WebSocket messages one turn costs a client of
 * the host socket, measured through the production coalescer, push log and
 * socket transport against a real `ws` client that offers compression, as a
 * browser does. Time is virtual, so the numbers do not depend on the machine.
 */

interface TimedEvent { t: number; event: HostPushEvent }
interface Budget { wireBytes: number; decodedBytes: number; messages: number }

const TOKEN = "transfer-budget-token";
const BUDGETS = JSON.parse(readFileSync(new URL("../../scripts/performance-budgets.json", import.meta.url), "utf8")).hostTransfer as Record<string, Budget>;

/** The recorded turn stores each tool update as what it added; the host sends the whole output. */
function recordedTurn(): { sessionId: string; events: TimedEvent[] } {
  const fixture = JSON.parse(readFileSync(new URL("../../benchmarks/host-transfer-turn.json", import.meta.url), "utf8")) as { events: Array<{ t: number; event: Record<string, unknown> }> };
  const outputs = new Map<string, string>();
  const events = fixture.events.map(({ t, event }) => {
    if (event.type !== "tool-update") return { t, event: event as unknown as HostPushEvent };
    const { append, ...rest } = event as { append: string; id: string };
    const output = (outputs.get(rest.id) ?? "") + append;
    outputs.set(rest.id, output);
    return { t, event: { ...rest, output } as unknown as HostPushEvent };
  });
  const first = events.find(({ event }) => event.type === "agent-status")!.event as { sessionId: string };
  return { sessionId: first.sessionId, events };
}

/** Deterministic text with enough variety that compression is not trivial. */
function diagnosticLines(seed: number, length: number): string {
  let out = "";
  for (let line = 0; out.length < length; line += 1) {
    const mixed = Math.imul(seed * 7_919 + line * 104_729, 0x9e3779b1) >>> 0;
    out += `${String(line + 1).padStart(6, "0")} src/main/module-${mixed % 17}.ts cursor=${mixed} digest=${mixed.toString(16).padStart(8, "0")}${(mixed * 31 >>> 0).toString(16)} status=completed\n`;
  }
  return out.slice(0, length);
}

/**
 * A heavy turn in the spirit of T3's transfer fixture: thinking, twenty short
 * tools, one tool streaming 1.1 MB (so the host's tail window slides), and a
 * 4 KB answer, streamed at a model's pace.
 */
function heavyTurn(template: TimedEvent[], big = { bytes: 1_100_000, chunks: 100 }): { sessionId: string; events: TimedEvent[] } {
  const sessionId = "transfer-heavy";
  const events: TimedEvent[] = [];
  let t = 0;
  const at = (event: HostPushEvent, advance = 0) => { events.push({ t, event }); t += advance; };
  const log = (label: string) => at({ type: "event-log", label, timestamp: t, sessionId });
  const stream = (type: "assistant-delta" | "assistant-thinking", id: string, text: string) => {
    for (let index = 0; index < text.length; index += 6) at({ type, sessionId, id, delta: text.slice(index, index + 6) }, 15);
  };
  const tools: UiToolRun[] = [];
  at({ type: "agent-status", sessionId, running: true });
  log("agent.started");
  at({ type: "user-message", sessionId, message: { id: "u1", role: "user", text: "Trace the transfer path.", timestamp: 1 } }, 400);
  const thinking = diagnosticLines(1, 1_200);
  at({ type: "assistant-start", sessionId, id: "a1", timestamp: 2 });
  stream("assistant-thinking", "a1", thinking);
  at({ type: "assistant-end", sessionId, message: { id: "a1", role: "assistant", text: "", thinking, timestamp: 2 } }, 50);
  const runTool = (index: number, chunks: readonly string[]) => {
    const tool: UiToolRun = { id: `tool-${index}`, name: "bash", args: { command: `inspect transfer path ${index}` }, status: "running", startedAt: t };
    at({ type: "tool-start", sessionId, tool });
    log("tool.started");
    let raw = "";
    for (const chunk of chunks) {
      raw += chunk;
      at({ type: "tool-update", sessionId, id: tool.id, output: boundedToolOutput(raw) }, 100);
    }
    const output = boundedToolOutput(raw);
    const ended: UiToolRun = { ...tool, status: "done", output, endedAt: t, ...(output !== raw ? { outputTruncated: true, fullOutputAvailable: true } : {}) };
    tools.push(ended);
    at({ type: "tool-end", sessionId, tool: ended });
    log("tool.ended");
    t += 50;
  };
  for (let index = 1; index <= 20; index += 1) {
    const output = diagnosticLines(100 + index, 1_000);
    runTool(index, [output.slice(0, 333), output.slice(333, 666), output.slice(666)]);
  }
  const bigOutput = diagnosticLines(999, big.bytes);
  const chunk = big.bytes / big.chunks;
  runTool(21, Array.from({ length: big.chunks }, (_, index) => bigOutput.slice(index * chunk, (index + 1) * chunk)));
  const answer = diagnosticLines(7, 4_096);
  at({ type: "assistant-start", sessionId, id: "a2", timestamp: 3 });
  stream("assistant-delta", "a2", answer);
  const reply = { id: "a2", role: "assistant" as const, text: answer, timestamp: 3 };
  at({ type: "assistant-end", sessionId, message: reply });
  at({ type: "host-update", update: { version: 1, type: "run", event: "settled", sessionId } });
  at({ type: "agent-status", sessionId, running: false });
  // The settled detail as the host sends it, on the recorded turn's shape.
  const recorded = template.find(({ event }) => event.type === "host-update" && event.update.type === "thread-detail")!.event as Extract<HostEvent, { type: "host-update" }>;
  const detail = structuredClone((recorded.update as { detail: Record<string, unknown> }).detail);
  Object.assign(detail, {
    threadId: sessionId,
    providerSessionId: sessionId,
    sessionId,
    messages: [{ id: "u1", role: "user", text: "Trace the transfer path.", timestamp: 1 }, reply],
    turnActivity: { tools, anchorMessageId: "u1" },
    turnActivityHistory: [{ id: "turn-activity-u1", anchorMessageId: "u1", tools, status: "completed" }],
  });
  at({ type: "host-update", update: { ...recorded.update, detail } as never });
  return { sessionId, events };
}

/** Timers that fire only when the test moves time forward. */
class VirtualClock implements CoalescerClock {
  private time = 0;
  private timers: Array<{ at: number; callback: () => void }> = [];

  setTimeout = (callback: () => void, ms: number) => {
    const timer = { at: this.time + ms, callback };
    this.timers.push(timer);
    return timer;
  };

  clearTimeout = (handle: unknown) => {
    this.timers = this.timers.filter((timer) => timer !== handle);
  };

  advanceTo(time: number): void {
    for (;;) {
      const due = this.timers.filter((timer) => timer.at <= time).sort((left, right) => left.at - right.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((timer) => timer !== due);
      this.time = due.at;
      due.callback();
    }
    this.time = Math.max(this.time, time);
  }
}

interface WireClient {
  /** The sequence the host's hello reply named for this client's first push. */
  nextSeq: number;
  frames: string[];
  bytesRead(): number;
  extensions(): string;
  untilSeq(seq: number): Promise<void>;
  close(): void;
}

/** An auxiliary client counts; a regular one starts from a snapshot and makes the host send outputs whole. */
async function connect(port: number, auxiliary = true): Promise<WireClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const frames: string[] = [];
  let lastSeq = 0;
  let waiting: { seq: number; resolve: () => void } | undefined;
  const replied = new Promise<number>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("open", () => socket.send(JSON.stringify({ type: "hello", id: "h1", hello: { protocol: HOST_TRANSPORT_VERSION, token: TOKEN, ...(auxiliary ? { auxiliary } : {}) } })));
    socket.on("message", (data) => {
      const text = String(data);
      const frame = JSON.parse(text) as { type: string; push?: HostPush; reply?: { nextSeq: number } };
      if (frame.type === "hello-reply") { resolve(frame.reply!.nextSeq); return; }
      frames.push(text);
      lastSeq = frame.push!.seq;
      if (waiting && lastSeq >= waiting.seq) waiting.resolve();
    });
  });
  // The TCP socket under the upgrade: its byte count is what crossed the wire.
  let raw: { bytesRead: number } = { bytesRead: 0 };
  socket.once("upgrade", (response) => { raw = response.socket; });
  const nextSeq = await replied;
  return {
    nextSeq,
    frames,
    bytesRead: () => raw.bytesRead,
    extensions: () => socket.extensions,
    untilSeq: (seq) => lastSeq >= seq ? Promise.resolve() : new Promise((resolve) => { waiting = { seq, resolve }; }),
    close: () => socket.close(),
  };
}

interface Measurement extends Budget {
  pushes: HostPush[];
  log: HostPushLog;
  extensions: string;
  /** The second client, when one joined mid-turn. */
  joined?: WireClient;
}

const transports: SocketHostTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
});

/** Plays the turn through the host's push path and counts what one client receives. */
async function measure(events: readonly TimedEvent[], options: { joinAt?: number } = {}): Promise<Measurement> {
  const log = new HostPushLog();
  const clock = new VirtualClock();
  let transport: SocketHostTransport | undefined;
  const pushes = new HostPushCoalescer((event) => {
    const push = log.record(event);
    transport?.deliver(push);
    return push.seq;
  }, { clock });
  transport = await startSocketHostTransport({
    listen: "127.0.0.1:0",
    methods: {},
    pushLog: log,
    hostVersion: "test",
    capabilities: [],
    token: TOKEN,
    beforeReply: () => pushes.flush(),
    onSnapshotClient: () => pushes.resendWholeOutputs(),
  });
  transports.push(transport);
  const client = await connect(transport.port);
  const before = client.bytesRead();
  let joined: WireClient | undefined;
  for (const { t, event } of events) {
    clock.advanceTo(t);
    if (options.joinAt !== undefined && !joined && t >= options.joinAt) joined = await connect(transport.port, false);
    pushes.publish(published(event));
  }
  pushes.flush();
  await client.untilSeq(log.nextSeq - 1);
  await joined?.untilSeq(log.nextSeq - 1);
  joined?.close();
  const wireBytes = client.bytesRead() - before;
  client.close();
  return {
    wireBytes,
    decodedBytes: client.frames.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0),
    messages: client.frames.length,
    pushes: client.frames.map((frame) => (JSON.parse(frame) as { push: HostPush }).push),
    log,
    extensions: client.extensions(),
    ...(joined ? { joined } : {}),
  };
}

/** A thread detail as the host publishes it: `HostPublication` shapes its tools for clients. */
function published(event: HostPushEvent): HostPushEvent {
  if (event.type !== "host-update" || event.update.type !== "thread-detail") return event;
  return { ...event, update: { ...event.update, detail: clientTranscript(event.update.detail) } };
}

/** What a client should end up with: every tool in the shape the host sends it. */
function asClientSees(event: HostEvent): HostEvent {
  if (event.type === "tool-update") return { ...event, output: liveToolOutput(event.output) };
  if (event.type === "tool-end") return { ...event, tool: clientToolRun(event.tool) };
  return published(event) as HostEvent;
}

/**
 * The events a workbench listener receives from these pushes through
 * `HostConnection`. `from` starts the client later; `gap` drops a range, which
 * the connection repairs by replaying from `log`.
 */
async function received(pushes: readonly HostPush[], log: HostPushLog, options: { from?: number; gap?: [number, number] } = {}): Promise<HostEvent[]> {
  const listeners = new Set<(push: HostPush) => void>();
  const start = options.from ?? 0;
  const transport: HostTransport = {
    platform: "test",
    request: async (method, params) => {
      if (method !== "hello") throw new Error(`unexpected ${method}`);
      const hello = params[0] as HostHello;
      const reply = helloReply(log, hello, { hostVersion: "test", capabilities: [] });
      return { id: "hello", result: hello.lastSeq === undefined ? { ...reply, nextSeq: start + 1 } : reply };
    },
    onPush: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const connection = new HostConnection(transport);
  const events: HostEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.start();
  const [gapStart, gapEnd] = options.gap ?? [0, 0];
  for (const push of pushes) {
    if (push.seq <= start || (push.seq >= gapStart && push.seq < gapEnd)) continue;
    for (const listener of listeners) listener(push);
    // The first push after a gap sends the connection back to the host for a replay.
    if (push.seq === gapEnd) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return events;
}

/** What the thread shows; how many revisions it took to get there may differ. */
function view(sessionId: string, events: readonly HostEvent[]) {
  let state: ThreadViewState = { ...createThreadViewState(), activeThreadId: sessionId };
  for (const event of events) state = reduceHostEvent(state, event);
  return { messages: state.transcript.messages, tools: state.tools };
}

function breakdown(pushes: readonly HostPush[]): Record<string, { pushes: number; bytes: number }> {
  const byType: Record<string, { pushes: number; bytes: number }> = {};
  for (const push of pushes) {
    const { event } = push;
    const key = event.type === "host-update" ? `host-update:${event.update.type}` : event.type;
    const entry = (byType[key] ??= { pushes: 0, bytes: 0 });
    entry.pushes += 1;
    entry.bytes += Buffer.byteLength(JSON.stringify(push));
  }
  return byType;
}

const scenarios = {
  "recorded-turn": () => recordedTurn(),
  "heavy-turn": () => heavyTurn(recordedTurn().events),
};

describe("host transfer budget", () => {
  for (const [name, scenario] of Object.entries(scenarios)) {
    it(`${name} stays within its budget and ends in the same state`, async () => {
      const { sessionId, events } = scenario();
      const measured = await measure(events);
      const observed = { wireBytes: measured.wireBytes, decodedBytes: measured.decodedBytes, messages: measured.messages };
      console.info(`host transfer ${name}: ${JSON.stringify(observed)} (${events.length} host events)`);
      // TRANSFER_BREAKDOWN=1 shows where the bytes go when a budget fails.
      if (process.env.TRANSFER_BREAKDOWN) console.info(breakdown(measured.pushes));
      expect(measured.extensions).toContain("permessage-deflate");
      const budget = BUDGETS[name]!;
      expect(observed.wireBytes, "wire bytes").toBeLessThanOrEqual(budget.wireBytes);
      expect(observed.decodedBytes, "decoded bytes").toBeLessThanOrEqual(budget.decodedBytes);
      expect(observed.messages, "messages").toBeLessThanOrEqual(budget.messages);

      const raw = events.map(({ event }) => event).filter((event): event is HostEvent => !isWireEvent(event) && event.type !== "job-progress" && event.type !== "job-done");
      const expected = view(sessionId, raw.map(asClientSees));
      expect(view(sessionId, await received(measured.pushes, measured.log))).toEqual(expected);
      // A client that loses part of the turn replays it from the log.
      const middle = Math.floor(measured.pushes.length / 2);
      expect(view(sessionId, await received(measured.pushes, measured.log, { gap: [middle - 5, middle + 5] }))).toEqual(expected);
    });
  }

  it("sends a running tool's output whole to a client that joins mid-run", async () => {
    // Small chunks, so the live tail travels as deltas until the join.
    const { events } = heavyTurn(recordedTurn().events, { bytes: 200_000, chunks: 400 });
    const sent = events.flatMap(({ event }) => event.type === "tool-update" && event.id === "tool-21" ? [liveToolOutput(event.output)] : []);
    const halfway = events.find(({ event }) => event.type === "tool-update" && liveToolOutput(event.output) === sent[200])!.t;
    const measured = await measure(events, { joinAt: halfway });
    const big = measured.pushes.filter(({ event }) => event.type !== "tool-end-delta" && "id" in event && event.id === "tool-21");
    const joined = measured.joined!;
    expect(big.filter(({ event }) => event.type === "tool-update-delta").length).toBeGreaterThan(big.length * 0.9);
    expect(big.find(({ seq }) => seq >= joined.nextSeq)?.event.type).toBe("tool-update");
    const late = await received(measured.pushes, measured.log, { from: joined.nextSeq - 1 });
    const outputs = late
      .filter((event): event is Extract<HostEvent, { type: "tool-update" }> => event.type === "tool-update" && event.id === "tool-21")
      .map((event) => event.output);
    // Every update after the join reaches it, the first one whole.
    expect(outputs).toEqual(sent.slice(sent.length - outputs.length));
    expect(outputs.length).toBe(big.filter(({ seq }) => seq >= joined.nextSeq).length);
    // It ends the tool as every client does: deferred, with its size.
    const isEnd = (event: HostPushEvent): event is Extract<HostEvent, { type: "tool-end" }> => event.type === "tool-end" && event.tool.id === "tool-21";
    const ended = late.find(isEnd);
    expect(ended?.tool).toEqual(clientToolRun(events.map(({ event }) => event).find(isEnd)!.tool));
    expect(ended?.tool).toMatchObject({ outputDeferred: true, outputLength: expect.any(Number) });
  });
});
