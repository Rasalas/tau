import type { HostExtension } from "tau/host-extension";
import { COMPACT_AT_KEY, DEFAULT_COMPACT_AT, readCompactAt, RESUME_COMPACTION_EXTENSION_ID } from "./protocol.js";

/**
 * General's "Compact context" for Pi threads (design 2i): once a turn has
 * settled past the chosen share of the window the thread compacts; Never
 * cancels Pi's own compaction at the threshold and keeps only the one that
 * rescues a context that overflowed.
 */
export default {
  id: RESUME_COMPACTION_EXTENSION_ID,
  name: "Resume Compaction",
  permissions: ["runtime:extend"],
  async activate(context) {
    const { services } = context;
    const read = async () => readCompactAt((await services.settings?.().catch(() => undefined))?.values[COMPACT_AT_KEY]) ?? DEFAULT_COMPACT_AT;
    let compactAt = await read();
    const stopConfig = services.observeConfigChanges((change) => {
      if (change.kind === "config") void read().then((next) => { compactAt = next; });
    });
    const release = services.registerRuntimeExtension("tau-compact-at", (pi) => {
      pi.on("agent_settled", (_event, ctx) => {
        const percent = ctx.getContextUsage()?.percent;
        if (compactAt !== "never" && percent != null && percent >= Number(compactAt)) {
          services.log("compact-at", `${Math.round(percent)}% ≥ ${compactAt}%`);
          ctx.compact({ onError: (error) => services.log("compact-at.failed", error.message) });
        }
      });
      pi.on("session_before_compact", (event) => (compactAt === "never" && event.reason === "threshold" ? { cancel: true } : undefined));
    });
    return () => { release(); stopConfig(); };
  },
} satisfies HostExtension;
