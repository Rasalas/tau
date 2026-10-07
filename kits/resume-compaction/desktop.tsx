import { Minimize2 } from "lucide-react";
import type { DesktopExtension } from "tau";
import { RESUME_COMPACTION_EXTENSION_ID, RESUME_COMPACTION_OPT_OUT_SERVICE, type ResumeCompactionOptOut } from "./protocol.js";
import { createResumeCompactionSendMode } from "./send-mode.js";
import { CompactAtRow, createSettingsPage, RESUME_COMPACTION_ROWS, setOff } from "./settings.js";

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
      plugin.registerSettingsPage({
        id: "resume-compaction.settings",
        label: "Resume compaction",
        description: "A thread quiet for over an hour with a long context resumes with a cold prompt cache. Its send button then compacts first, on the runtimes whose provider caches the prompt.",
        Icon: Minimize2,
        group: "threads",
        order: 60,
        keywords: ["compact", "context", "prompt cache"],
        profiles: EVERY_CLIENT,
        rows: RESUME_COMPACTION_ROWS,
        Component: createSettingsPage(preferences),
      }),
      plugin.registerSettingsSection({ id: "resume-compaction.compact-at", page: "general", card: "threads", order: 20, profiles: EVERY_CLIENT, Component: CompactAtRow,
        rows: [{ id: "setting-compact-context", label: "Compact context", keywords: ["compaction", "context window", "threads"] }] }),
      plugin.provideService(RESUME_COMPACTION_OPT_OUT_SERVICE, optOut),
    ];
    return () => { for (const stop of stops) stop(); };
  },
};

export default resumeCompactionExtension;
