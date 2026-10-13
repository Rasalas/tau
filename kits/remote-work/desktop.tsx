import { useEffect } from "react";
import type { DesktopExtension, RegionProps, WorkbenchActions } from "tau";
import { REMOTE_WORK_EXTENSION_ID, THREAD_LINK_EVENT, type RemoteThreadLink } from "./protocol.js";
import { QuestionNotices } from "./questions.js";
import { REMOTE_WORK_ROWS, createRemoteWorkSections } from "./settings.js";

/** The Machines extension's agents catalog (`kits/environments/host.ts`) and settings page; kits do not import one another. */
const MACHINES_EXTENSION_ID = "tau.environments";
const MACHINES_SETTINGS_PAGE = "environments.machines";

export const REMOTE_WORK_SETTINGS_PAGE = "remote-work.settings";

/**
 * The Remote Work extension's desktop half: sections of Settings → Machines,
 * where a project's ignored files that go along are chosen once and its
 * transfers are brought back and merged, and a notice when a thread it runs on
 * another machine asks something there. Starting work elsewhere belongs to the
 * extensions that do it.
 */
export const remoteWorkExtension: DesktopExtension = {
  id: REMOTE_WORK_EXTENSION_ID,
  name: "Remote Work",
  activate(context) {
    let actions: WorkbenchActions | undefined;
    const machines = context.hostExtension(MACHINES_EXTENSION_ID);
    const notices = new QuestionNotices({
      actions: () => actions,
      attention: () => context.attention,
      environments: () => context.environments,
      connectedAgents: async (machine) => {
        const catalog = await machines.invoke("agents").catch(() => undefined) as { machines?: Array<{ id: string; status: string }> } | undefined;
        return catalog?.machines?.some((entry) => entry.id === machine && entry.status === "connected") === true;
      },
      focused: () => document.visibilityState !== "hidden" && document.hasFocus(),
    });
    let seeded = false;
    const early: RemoteThreadLink[] = [];
    const stop = context.host.onEvent(THREAD_LINK_EVENT, (payload) => {
      const link = payload as RemoteThreadLink;
      if (!link?.id) return;
      if (seeded) notices.update(link);
      else early.push(link);
    });
    context.host.invoke("threads", {}).then((value) => {
      if (Array.isArray(value)) notices.seed(value as RemoteThreadLink[]);
    }, () => undefined).finally(() => {
      seeded = true;
      for (const link of early.splice(0)) notices.update(link);
    });
    // Thread navigation needs the workbench's actions, which a region receives.
    context.registerRegion({
      id: "remote-work.questions",
      placement: "composer-above",
      profiles: ["desktop", "web"],
      Component: function RemoteWorkQuestions({ actions: next }: RegionProps) {
        useEffect(() => { actions = next; }, [next]);
        return null;
      },
    });
    // Below the machines on Settings → Machines; a browser has no such page, so there they are on this extension's own.
    context.registerSettingsSection({
      id: "remote-work.sections",
      page: MACHINES_SETTINGS_PAGE,
      order: 50,
      profiles: ["desktop", "web"],
      replaces: [REMOTE_WORK_SETTINGS_PAGE],
      rows: REMOTE_WORK_ROWS.map((row) => ({ ...row, keywords: ["remote work", "other machine", "transfer", "bundle", ...row.keywords] })),
      // A client without a window process (a browser, a phone) cannot move to another machine.
      Component: createRemoteWorkSections(context.host, context.environments ? (link) => notices.openThere(link) : undefined),
    });
    return () => { stop(); notices.dispose(); };
  },
};

export default remoteWorkExtension;
