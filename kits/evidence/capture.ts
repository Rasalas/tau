import { randomUUID } from "node:crypto";
import type { EvidenceStore } from "./store.js";
import { isDuplicate, isScreenTool, previewCaption, previewToolName, screenCaption, type Luma } from "./frames.js";
import {
  FRAMES_PER_TURN,
  PERIODIC_MS,
  type EncodedFrame,
  type EvidenceFrame,
  type EvidenceSettings,
  type EvidenceSource,
  type EvidenceTrigger,
  type PreviewEvidenceFrame,
  type ScreenFrame,
  type ScreenState,
} from "./protocol.js";

/** Everything capture reaches outside itself; the host wires the real ones, a test its fakes. */
export interface CaptureDeps {
  store: EvidenceStore;
  settings(cwd: string): Promise<EvidenceSettings>;
  /** Preview Kit's frame; `undefined` when the kit is not there. */
  preview(): Promise<PreviewEvidenceFrame | undefined>;
  screenState(threadId: string): Promise<ScreenState | null | undefined>;
  screenFrame(threadId: string, seq: number): Promise<ScreenFrame | null | undefined>;
  encode(data: string): Promise<EncodedFrame>;
  /** The project a thread runs in, when its runtime is open. */
  cwdOf(threadId: string): string | undefined;
  /** The thread a client has on screen. */
  activeThread(): string | undefined;
  changed(threadId: string): void;
  now(): number;
  log(label: string, detail?: string): void;
}

interface TurnState {
  turnId: string;
  startedAt: number;
  /** The agent drove the Preview in this turn, so its frames belong here whoever watches. */
  previewUsed: boolean;
  lastPreviewAt: number;
  /** The page when the turn started, kept only once something in the turn differs from it. */
  before?: Shot & { encoded: EncodedFrame; luma: Luma; at: number };
  /** The turn's last kept frame of each source, what the next one is compared with. */
  luma: Partial<Record<EvidenceSource, Luma>>;
}

interface Shot {
  source: EvidenceSource;
  trigger: EvidenceTrigger;
  caption: string;
  data: string;
  extra: Pick<EvidenceFrame, "url" | "app" | "title">;
}

interface ThreadState {
  cwd?: string;
  /** Accepted prompts not started yet; `joins` marks a steer that joins the running turn. */
  queue: Array<{ turnId: string; joins: boolean }>;
  turn?: TurnState;
  screenSeq?: number;
  screenAt: number;
  chain: Promise<unknown>;
}

type Kept = { frame: EvidenceFrame } | { skipped: string };

const TRIGGER_CAPTIONS: Partial<Record<EvidenceTrigger, string>> = {
  "turn-start": "When the turn started",
  "turn-end": "When the turn ended",
  periodic: "While the agent worked",
};

/**
 * Takes frames for the turns of every thread: from the Preview at a turn's
 * edges, after each Preview call and every few seconds, and from the window
 * the agent drives whenever its driver took a new screenshot. Nothing is taken
 * outside a turn, from a paused thread, or while a secret has the keyboard.
 */
export class EvidenceCapture {
  private readonly threads = new Map<string, ThreadState>();

  private readonly pauses = new Map<string, string>();

  constructor(private readonly deps: CaptureDeps) {}

  private state(threadId: string): ThreadState {
    let state = this.threads.get(threadId);
    if (!state) this.threads.set(threadId, state = { queue: [], screenAt: 0, chain: Promise.resolve() });
    return state;
  }

  private cwd(threadId: string): string {
    const state = this.threads.get(threadId);
    return this.deps.cwdOf(threadId) ?? state?.cwd ?? "";
  }

  /** Runs capture work of one thread in order, so each frame is compared with the one before it. */
  private serial<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const state = this.state(threadId);
    const next = state.chain.catch(() => undefined).then(work);
    state.chain = next.catch((error: unknown) => this.deps.log("evidence.capture-failed", error instanceof Error ? error.message : String(error)));
    return next;
  }

  private begin(threadId: string, turnId: string): TurnState {
    const state = this.state(threadId);
    state.queue = state.queue.filter((entry) => entry.turnId !== turnId);
    // Every turn compares with its own frames, so it keeps a first one even when it looks like the last turn's end.
    const turn: TurnState = { turnId, startedAt: this.deps.now(), previewUsed: false, lastPreviewAt: this.deps.now(), luma: {} };
    state.turn = turn;
    return turn;
  }

  accepted(threadId: string, turnId: string, options: { deferBefore: boolean; expectsInput?: boolean }): void {
    this.state(threadId).queue.push({ turnId, joins: options.expectsInput === false && options.deferBefore });
  }

  /** A turn starts: what the Preview shows now is its "before". */
  prepare(threadId: string, turnId: string): Promise<void> {
    const turn = this.begin(threadId, turnId);
    // The runtime waits for this hook, so the frame is taken behind it.
    void this.serial(threadId, () => this.previewFrame(threadId, turn, "turn-start"));
    return Promise.resolve();
  }

  cancelled(threadId: string, turnId: string): void {
    const state = this.threads.get(threadId);
    if (!state) return;
    state.queue = state.queue.filter((entry) => entry.turnId !== turnId);
    if (state.turn?.turnId === turnId) state.turn = undefined;
  }

  /** A turn settled: its "after", then the next queued prompt's turn begins. */
  ended(threadId: string, turnId: string): Promise<void> {
    const state = this.threads.get(threadId);
    if (!state) return Promise.resolve();
    if (state.turn?.turnId !== turnId) {
      state.queue = state.queue.filter((entry) => entry.turnId !== turnId);
      return Promise.resolve();
    }
    const turn = state.turn;
    const endedAt = this.deps.now();
    void this.serial(threadId, async () => {
      await this.previewFrame(threadId, turn, "turn-end");
      if (await this.deps.store.endTurn(threadId, turn.turnId, endedAt)) this.deps.changed(threadId);
    });
    state.turn = undefined;
    state.queue = state.queue.filter((entry) => !entry.joins);
    const next = state.queue[0];
    if (next) this.begin(threadId, next.turnId);
    return Promise.resolve();
  }

  closed(threadId: string): void {
    const state = this.threads.get(threadId);
    if (state && !state.turn && state.queue.length === 0) this.threads.delete(threadId);
    this.deps.store.forget(threadId);
  }

  /** A tool call ended: a Preview call earns a frame of the page, a computer-use call the driver's newest screenshot. */
  toolEnded(threadId: string, tool: { id: string; name: string; args: Record<string, unknown> }, cwd: string): void {
    const state = this.state(threadId);
    if (cwd) state.cwd = cwd;
    const turn = state.turn;
    if (!turn) return;
    if (previewToolName(tool.name)) {
      turn.previewUsed = true;
      void this.serial(threadId, () => this.previewFrame(threadId, turn, "action", previewCaption(tool.name, tool.args)));
    } else if (isScreenTool(tool.name)) {
      void this.serial(threadId, () => this.screenFrame(threadId, turn, "action"));
    }
  }

  /** The clock: a running turn's Preview, at most every `PERIODIC_MS`. */
  tick(): void {
    const now = this.deps.now();
    for (const [threadId, state] of this.threads) {
      const turn = state.turn;
      if (!turn || now - turn.lastPreviewAt < PERIODIC_MS) continue;
      turn.lastPreviewAt = now;
      void this.serial(threadId, () => this.previewFrame(threadId, turn, "periodic"));
    }
  }

  /** Resolves once every capture asked for so far has run. */
  async settled(): Promise<void> {
    for (;;) {
      const chains = [...this.threads.values()].map((state) => state.chain);
      await Promise.all(chains);
      if (chains.every((chain, index) => [...this.threads.values()][index]?.chain === chain)) return;
    }
  }

  running(): boolean {
    return [...this.threads.values()].some((state) => state.turn);
  }

  pause(threadId: string, reason: string): void {
    this.pauses.set(threadId, reason.trim() || "Paused");
  }

  resume(threadId: string): void {
    this.pauses.delete(threadId);
  }

  paused(): Record<string, string> {
    return Object.fromEntries(this.pauses);
  }

  /**
   * The agent's own frame, with its caption: from the Preview unless it asked
   * for the window, and from the window when the Preview has nothing.
   */
  attach(threadId: string, cwd: string, caption: string, source?: "preview" | "window"): Promise<string> {
    const state = this.state(threadId);
    if (cwd) state.cwd = cwd;
    return this.serial(threadId, async () => {
      const reason = this.pauses.get(threadId);
      if (reason) return `Not attached: evidence capture is paused for this thread (${reason}).`;
      // A prompt Tau does not bracket, as in a Pi terminal Tau is only attached to, gets a turn of its own.
      const turn = state.turn ?? { turnId: `turn-${randomUUID()}`, startedAt: this.deps.now(), previewUsed: false, lastPreviewAt: 0, luma: {} };
      const settle = async () => { if (turn !== state.turn && await this.deps.store.endTurn(threadId, turn.turnId, this.deps.now())) this.deps.changed(threadId); };
      const outcomes: string[] = [];
      if (source !== "window") {
        const kept = await this.previewFrame(threadId, turn, "agent", caption);
        if ("frame" in kept) {
          await settle();
          return `Attached “${caption}” from the Preview (${String(kept.frame.width)}×${String(kept.frame.height)}).`;
        }
        outcomes.push(kept.skipped === "secret" ? "a password field has focus in the Preview" : `the Preview: ${kept.skipped}`);
      }
      if (source !== "preview") {
        const kept = await this.screenFrame(threadId, turn, "agent", caption);
        if ("frame" in kept) {
          await settle();
          return `Attached “${caption}” from ${kept.frame.app ?? "the window"} (${String(kept.frame.width)}×${String(kept.frame.height)}).`;
        }
        outcomes.push(`the window: ${kept.skipped}`);
      }
      return `Not attached: ${outcomes.join("; ")}.`;
    });
  }

  private async previewFrame(threadId: string, turn: TurnState, trigger: EvidenceTrigger, caption?: string): Promise<Kept> {
    if (this.pauses.size > 0) return { skipped: "capture is paused" };
    const settings = await this.deps.settings(this.cwd(threadId));
    const agent = trigger === "agent";
    if (!agent && !settings.preview) return { skipped: "off for this project" };
    // Unless the agent drives the Preview, its page belongs to the thread the user watches beside it.
    const watched = this.deps.activeThread() === threadId;
    if (!agent && !turn.previewUsed && !watched) return { skipped: "not this thread's page" };
    turn.lastPreviewAt = this.deps.now();
    const answer = await this.deps.preview().catch(() => undefined);
    if (!answer) return { skipped: "Preview is not there" };
    if ("skipped" in answer) return { skipped: answer.skipped === "closed" ? "no page is open" : answer.skipped };
    if (!agent && !turn.previewUsed && !answer.visible) return { skipped: "the panel is hidden" };
    return this.keep(threadId, turn, settings, {
      source: "preview",
      trigger,
      caption: caption ?? TRIGGER_CAPTIONS[trigger] ?? answer.title,
      data: answer.data,
      extra: { url: answer.url, ...(answer.title ? { title: answer.title } : {}) },
    });
  }

  private async screenFrame(threadId: string, turn: TurnState, trigger: EvidenceTrigger, caption?: string): Promise<Kept> {
    const state = this.state(threadId);
    if (this.pauses.has(threadId)) return { skipped: "capture is paused" };
    const settings = await this.deps.settings(this.cwd(threadId));
    const agent = trigger === "agent";
    if (!agent && !settings.screen) return { skipped: "off for this project" };
    const screen = await this.deps.screenState(threadId).catch(() => undefined);
    const info = screen?.frame;
    if (!info) return { skipped: "this thread drives no window" };
    if (!agent && info.seq === state.screenSeq) return { skipped: "no new screenshot" };
    const frame = await this.deps.screenFrame(threadId, info.seq).catch(() => undefined);
    if (!frame) return { skipped: "the screenshot is gone" };
    const since = state.screenAt;
    const action = screen.actions.filter((entry) => entry.at > since && entry.at <= info.at).at(-1);
    const window = frame.window;
    const kept = await this.keep(threadId, turn, settings, {
      source: "screen",
      trigger,
      caption: caption ?? screenCaption(action, window.app),
      data: frame.data,
      extra: { ...(window.app ? { app: window.app } : {}), ...(window.title ? { title: window.title } : {}) },
    });
    state.screenSeq = info.seq;
    state.screenAt = info.at;
    return kept;
  }

  private async keep(threadId: string, turn: TurnState, settings: EvidenceSettings, shot: Shot): Promise<Kept> {
    const encoded = await this.deps.encode(shot.data);
    const luma: Luma = { width: encoded.lumaWidth, height: encoded.lumaHeight, pixels: new Uint8Array(Buffer.from(encoded.luma, "base64")) };
    if (shot.trigger === "turn-start") {
      turn.before = { ...shot, encoded, luma, at: this.deps.now() };
      return { skipped: "kept back until something changes" };
    }
    const before = turn.before?.source === shot.source ? turn.before : undefined;
    if (isDuplicate(turn.luma[shot.source] ?? before?.luma, luma, shot.trigger)) return { skipped: "nothing changed" };
    const limits = { framesPerTurn: FRAMES_PER_TURN, threadBytes: settings.threadMegabytes * 1024 * 1024 };
    if (before) {
      turn.before = undefined;
      // The agent's own frame of an unchanged page says the same as the start did.
      if (!isDuplicate(before.luma, luma, "action")) await this.store(threadId, turn, before, before.encoded, before.at, limits);
    }
    const frame = await this.store(threadId, turn, shot, encoded, this.deps.now(), limits);
    if (!frame) return { skipped: "the turn has no room left" };
    turn.luma[shot.source] = luma;
    this.deps.changed(threadId);
    return { frame };
  }

  private store(threadId: string, turn: TurnState, shot: Shot, encoded: EncodedFrame, at: number, limits: { framesPerTurn: number; threadBytes: number }): Promise<EvidenceFrame | undefined> {
    return this.deps.store.add(threadId, this.cwd(threadId), turn, {
      at,
      source: shot.source,
      trigger: shot.trigger,
      caption: shot.caption,
      width: encoded.width,
      height: encoded.height,
      mediaType: "image/jpeg",
      ...shot.extra,
    }, { frame: Buffer.from(encoded.frame, "base64"), thumb: Buffer.from(encoded.thumb, "base64") }, limits);
  }
}
