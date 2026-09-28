import { useEffect } from "react";
import { FolderSync } from "lucide-react";
import type { DesktopExtension, RegionProps, WorkbenchActions } from "tau";
import { REMOTE_WORK_EXTENSION_ID, THREAD_LINK_EVENT, type RemoteThreadLink } from "./protocol.js";
import { QuestionNotices } from "./questions.js";
import { REMOTE_WORK_ROWS, createRemoteWorkPage } from "./settings.js";

export const REMOTE_WORK_SETTINGS_PAGE = "remote-work.settings";

/**
 * Remote Work Kit's desktop half: Settings → Remote work, where a project's
 * ignored files that go along are chosen once and its transfers are brought
 * back and merged, and a notice when a thread it runs on another machine asks
 * something there. Starting work elsewhere belongs to the kits that do it.
 */
export const remoteWorkExtension: DesktopExtension = {
  id: REMOTE_WORK_EXTENSION_ID,
  name: "Remote Work",
  activate(context) {
    let actions: WorkbenchActions | undefined;
    const notices = new QuestionNotices({
      actions: () => actions,
      attention: () => context.attention,
      environments: () => context.environments,
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
    // The toast and the moves need the workbench's actions, which a region receives.
    context.registerRegion({
      id: "remote-work.questions",
      placement: "composer-above",
      profiles: ["desktop", "web"],
      Component: function RemoteWorkQuestions({ actions: next }: RegionProps) {
        useEffect(() => { actions = next; }, [next]);
        return null;
      },
    });
    context.registerSettingsPage({
      id: REMOTE_WORK_SETTINGS_PAGE,
      label: "Remote work",
      description: "What goes along when a project's work moves to another machine: its commits, its uncommitted work and the ignored files you choose.",
      group: "remote",
      Icon: FolderSync,
      order: 45.5,
      profiles: ["desktop", "web"],
      keywords: ["other machine", "remote machine", "transfer", "bundle", "ignored files", ".env", "bring back", "merge"],
      rows: REMOTE_WORK_ROWS,
      // A client without a window process (a browser, a phone) cannot move to another machine.
      Component: createRemoteWorkPage(context.host, context.environments ? (link) => notices.openThere(link) : undefined),
    });
    return () => { stop(); notices.dispose(); };
  },
};

export default remoteWorkExtension;
