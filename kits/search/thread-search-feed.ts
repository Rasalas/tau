import type { PaletteSearchContext } from "tau";
import type { SearchHost } from "./dialogs.js";
import { messageIndexNotice, type MessageIndexFeed } from "./index-feed.js";
import type { ThreadMatch, ThreadSearchInput, ThreadSearchPage } from "./protocol.js";
import { settle } from "./palette-sources.js";

/** A source answers with partial rows immediately, then tells the palette to read again. */
export class ThreadSearchFeed {
  private listeners = new Set<() => void>();
  private run?: { signal: AbortSignal; key: string; matches: ThreadMatch[]; first: Promise<ThreadMatch[]>; complete: boolean; pendingNotice?: string; partial?: string; cancel(): void };
  private accepting = false;
  private readonly stopIndex: () => void;
  constructor(private host: SearchHost, private index: MessageIndexFeed) {
    let before = index.snapshot();
    let initialized = index.loaded;
    this.stopIndex = index.subscribe(() => {
      const next = index.snapshot();
      const mode = (state: typeof next) => !state.enabled || state.state === "error" || state.state === "unavailable" ? "recent" : "full";
      const wasInitialized = initialized;
      initialized = true;
      const changed = wasInitialized && !this.accepting && (mode(before) !== mode(next) || before.state === "indexing" && next.state === "ready" && this.run?.complete);
      before = next;
      if (!changed || !this.run) return;
      this.run.cancel();
      this.run = undefined;
      this.listeners.forEach(listener => listener());
    });
  }
  notice = (): string | undefined => this.index.notice() ?? (!this.run?.complete ? this.run?.pendingNotice : undefined);
  partial = (): string | undefined => this.run?.partial;
  private unavailable(): void {
    this.accepting = true;
    try { this.index.unavailable(); } finally { this.accepting = false; }
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    const stop = this.index.subscribeStatus(listener);
    return () => { this.listeners.delete(listener); stop(); };
  };
  async search(input: ThreadSearchInput, context: PaletteSearchContext): Promise<ThreadMatch[]> {
    const key = JSON.stringify(input);
    if (this.run?.signal === context.signal && this.run.key === key) { const held = this.run; return held.first.then(() => held.matches); }
    const request = { ...input, channel: `messages-${Math.random().toString(36).slice(2)}` };
    const run = { pendingNotice: undefined as string | undefined, partial: undefined as string | undefined, complete: false, cancel: () => {}, signal: context.signal, key, matches: [] as ThreadMatch[], first: Promise.resolve([] as ThreadMatch[]) };
    this.run = run;
    let legacy = false;
    const cancel = () => {
      void this.host("thread-search-cancel", { channel: request.channel }).catch(() => undefined);
      if (legacy) void this.host("threads", { query: "", channel: request.channel }).catch(() => undefined);
    };
    run.cancel = cancel;
    context.signal.addEventListener("abort", cancel, { once: true });
    const accept = (page: ThreadSearchPage) => {
      if (context.signal.aborted || this.run !== run) return;
      run.matches = page.matches;
      run.complete = page.complete;
      run.partial = page.error ?? (page.truncated ? "Some thread content was not searched because search limits were reached." : undefined);
      if (!page.complete) run.pendingNotice ??= messageIndexNotice({ ...page.status, state: "indexing" });
      this.accepting = true;
      try { this.index.accept(page.status); } finally { this.accepting = false; }
      this.listeners.forEach(listener => listener());
    };
    const poll = async (page: ThreadSearchPage) => {
      try {
        while (!context.signal.aborted && this.run === run && !page.complete && page.continuation) {
          await settle(150, context.signal);
          if (context.signal.aborted) return;
          page = await this.host("thread-search", { ...request, continuation: page.continuation });
          accept(page);
        }
      } catch {
        run.partial = "Some thread content could not be searched.";
        this.unavailable();
        this.listeners.forEach(listener => listener());
      }
      finally { context.signal.removeEventListener("abort", cancel); }
    };
    run.first = (async () => {
      try {
        const page = await this.host("thread-search", request);
        // Older test doubles and older machines may return no new contract.
        if (!page || !Array.isArray(page.matches)) throw new Error("Message index unavailable");
        accept(page);
        void poll(page);
        return context.signal.aborted ? [] : page.matches;
      } catch {
        if (context.signal.aborted || this.run !== run) return [];
        this.unavailable();
        legacy = true;
        try {
          const answer = await this.host("threads", { ...request, includeStatus: true });
          const result = Array.isArray(answer) ? { matches: answer, truncated: false } : answer;
          if (context.signal.aborted || result.cancelled || this.run !== run) return [];
          run.matches = result.matches;
          run.complete = true;
          run.partial = result.error ?? (result.truncated ? "Some thread content was not searched because search limits were reached." : undefined);
          return result.matches;
        } finally { context.signal.removeEventListener("abort", cancel); }
      }
    })();
    return run.first;
  }
  dispose(): void { this.stopIndex(); this.run?.cancel(); this.run = undefined; this.listeners.clear(); }
}
