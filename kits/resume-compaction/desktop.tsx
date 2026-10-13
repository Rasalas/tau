import type { DesktopExtension } from "tau";
import { RESUME_COMPACTION_EXTENSION_ID, RESUME_COMPACTION_OPT_OUT_SERVICE, type ResumeCompactionOptOut } from "./protocol.js";
import { createResumeCompactionSendMode } from "./send-mode.js";
import { CompactAtRow, createOfferRows, RESUME_COMPACTION_ROWS, setOff } from "./settings.js";

const EVERY_CLIENT = ["desktop", "web", "compact"] as const;

/**
 * Compacts a long thread whose prompt cache has gone cold before its next
 * prompt, so the turn does not pay for all of it again. The answers live in
 * Tau's config, so they hold on every device.
 */
export const resumeCompactionExtension: DesktopExtension = {
  id: RESUME_COMPACTION_EXTENSION_ID,
  name: "Resume Compaction",
  activate(plugin) {
    const preferences = plugin.preferences;
    const optOut: ResumeCompactionOptOut = { turnOff: (runtime) => setOff(preferences, runtime, true) };
    const stops = [
      plugin.registerComposerSendMode(createResumeCompactionSendMode({ preferences })),
      // Threads' Long threads card (API 1.61.0); the page it had before opens Threads.
      plugin.registerSettingsSection({ id: "resume-compaction.offer", page: "threads", card: "long-threads", order: 20, profiles: EVERY_CLIENT, replaces: ["resume-compaction.settings"], Component: createOfferRows(preferences),
        rows: RESUME_COMPACTION_ROWS }),
      plugin.registerSettingsSection({ id: "resume-compaction.compact-at", page: "threads", card: "long-threads", order: 10, profiles: EVERY_CLIENT, Component: CompactAtRow,
        rows: [{ id: "setting-compact-context", label: "Compact context", keywords: ["compaction", "context window", "threads"] }] }),
      plugin.provideService(RESUME_COMPACTION_OPT_OUT_SERVICE, optOut),
    ];
    return () => { for (const stop of stops) stop(); };
  },
};

export default resumeCompactionExtension;
