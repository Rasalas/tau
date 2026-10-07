import { Minimize2 } from "lucide-react";
import type { ComposerSendMode, ComposerSendModeContribution, PreferencesStore } from "tau";
import { formatContextTokens, offerDueAt, offersResumeCompaction } from "./rule.js";
import { readOff, setOff } from "./settings.js";

type Preferences = Pick<PreferencesStore, "subscribe" | "getSnapshot" | "value" | "setValue">;

export interface SendModeOptions {
  preferences: Preferences;
  /** The clock; tests pass their own. */
  now?(): number;
}

/**
 * "Compact and send": a thread whose context is large and whose prompt cache
 * has gone cold compacts before the next prompt, instead of writing all of it
 * into the cache again. The menu beside the button sends with the full history.
 */
export function createResumeCompactionSendMode({ preferences, now = Date.now }: SendModeOptions): ComposerSendModeContribution {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt: number | undefined;
  let cached: { key: string; mode: ComposerSendMode } | undefined;
  // Asks again once the offer falls due, so the button changes without a turn.
  const wakeAt = (at: number) => {
    if (timerAt !== undefined && timerAt <= at) return;
    clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(() => {
      timer = timerAt = undefined;
      for (const listener of [...listeners]) listener();
    }, Math.max(0, at - now()) + 1_000);
  };
  return {
    id: "resume-compaction.send",
    profiles: ["desktop", "web", "compact"],
    subscribe(listener) {
      listeners.add(listener);
      const stop = preferences.subscribe(listener);
      return () => {
        listeners.delete(listener);
        stop();
        if (listeners.size === 0) { clearTimeout(timer); timer = timerAt = undefined; }
      };
    },
    read(snapshot) {
      const usage = snapshot.contextUsage;
      const runtime = snapshot.backendKind ?? "pi";
      if (!usage || readOff(preferences).includes(runtime)) return undefined;
      if (!offersResumeCompaction(usage, now())) {
        const due = offerDueAt(usage);
        if (due !== undefined) wakeAt(due);
        return undefined;
      }
      const runtimeLabel = snapshot.runtimeBackends?.find((backend) => backend.kind === runtime)?.label ?? runtime;
      const key = `${runtime}|${runtimeLabel}|${usage.tokens}|${usage.updatedAt}`;
      if (cached?.key === key) return cached.mode;
      const tokens = formatContextTokens(usage.tokens);
      const mode: ComposerSendMode = {
        label: "Compact and send",
        busyLabel: "Compacting…",
        Icon: Minimize2,
        title: `Summarize ${tokens} tokens of earlier history, then send`,
        async beforeSend(actions) {
          if (!actions?.compactContext) throw new Error("Compaction is unavailable here.");
          if (await actions.compactContext() === false) throw new Error("Not sent: the compaction failed. Send with full history from the menu beside the button.");
        },
        options: [
          { id: "full-history", label: "Send with full history", detail: `Re-reads all ${tokens} tokens`, send: true },
          { id: "always-full-history", label: "Always send with full history", detail: `Stops offering this for ${runtimeLabel}`, send: true, run: () => setOff(preferences, runtime, true) },
        ],
      };
      cached = { key, mode };
      return mode;
    },
  };
}
