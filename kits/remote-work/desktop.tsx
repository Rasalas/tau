import { FolderSync } from "lucide-react";
import type { DesktopExtension } from "tau";
import { REMOTE_WORK_EXTENSION_ID } from "./protocol.js";
import { createRemoteWorkPage } from "./settings.js";

export const REMOTE_WORK_SETTINGS_PAGE = "remote-work.settings";

/**
 * Remote Work Kit's desktop half: Settings → Remote work, where a project's
 * ignored files that go along are chosen once and its transfers are brought
 * back and merged. Starting work elsewhere belongs to the kits that do it.
 */
export const remoteWorkExtension: DesktopExtension = {
  id: REMOTE_WORK_EXTENSION_ID,
  name: "Remote Work",
  activate(context) {
    context.registerSettingsPage({
      id: REMOTE_WORK_SETTINGS_PAGE,
      label: "Remote work",
      Icon: FolderSync,
      order: 45.5,
      profiles: ["desktop", "web"],
      keywords: ["other machine", "rex", "transfer", "bundle", "ignored files", ".env", "bring back", "merge"],
      Component: createRemoteWorkPage(context.host),
    });
  },
};

export default remoteWorkExtension;
