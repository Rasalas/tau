import { Minimize2 } from "lucide-react";
import type { DesktopExtension } from "tau";
import { createResumeCompactionBanner } from "./banner.js";
import { RESUME_COMPACTION_EXTENSION_ID, RESUME_COMPACTION_OPT_OUT_SERVICE, type ResumeCompactionOptOut } from "./protocol.js";
import { createSettingsPage, RESUME_COMPACTION_ROWS, setOff } from "./settings.js";

const EVERY_CLIENT = ["desktop", "web", "compact"] as const;

/**
 * Offers to compact a long thread whose prompt cache has gone cold, before
 * the next turn pays for all of it again. Where the answers live is Tau's config, so they hold on every
 * device.
 */
export const resumeCompactionExtension: DesktopExtension = {
  id: RESUME_COMPACTION_EXTENSION_ID,
  name: "Resume Compaction",
  activate(plugin) {
    const preferences = plugin.preferences;
    const optOut: ResumeCompactionOptOut = { turnOff: (runtime) => setOff(preferences, runtime, true) };
    const stops = [
      // Just above the composer, below the runtime's version and update notices.
      plugin.registerRegion({ id: "resume-compaction.offer", placement: "composer-above", order: 20, profiles: EVERY_CLIENT, Component: createResumeCompactionBanner({ preferences }) }),
      plugin.registerSettingsPage({
        id: "resume-compaction.settings",
        label: "Resume compaction",
        description: "A thread quiet for over an hour with a long context resumes with a cold prompt cache. Tau then offers to compact it first, on the runtimes whose provider caches the prompt.",
        Icon: Minimize2,
        group: "threads",
        order: 60,
        keywords: ["compact", "context", "prompt cache"],
        profiles: EVERY_CLIENT,
        rows: RESUME_COMPACTION_ROWS,
        Component: createSettingsPage(preferences),
      }),
      plugin.provideService(RESUME_COMPACTION_OPT_OUT_SERVICE, optOut),
    ];
    return () => { for (const stop of stops) stop(); };
  },
};

export default resumeCompactionExtension;
