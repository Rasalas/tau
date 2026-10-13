// @vitest-environment jsdom
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopExtension } from "tau";
import { createKitHarness } from "../src/renderer/test-support/kit-harness.js";
import { renderKitSettingsPage } from "../src/renderer/test-support/kit-settings-page.js";
import evidence from "./evidence/desktop.js";
import notifications from "./notifications/desktop.js";
import push from "./push/desktop.js";
import snapshots from "./snapshots/desktop.js";
import review from "./review/desktop.js";
import workspace from "./workspace/desktop.js";

afterEach(cleanup);

/** The host halves answer little: lists are empty, a status has no devices, the rest is unset. */
const answer = vi.fn(async (_extension: string, command: string) => command === "source-hosts" ? {} : command === "source-providers" ? [] : command === "status" ? { devices: [], file: "/keys.json" } : undefined);

/** One extension's page draws what another attached to it, and the other's old page id opens it (API 1.61.0). */
describe("Settings pages that take in another extension's sections", () => {
  const merges: Array<{ name: string; host: DesktopExtension; page: string; guest: DesktopExtension; oldPage: string; row: string }> = [
    { name: "Notifications takes Push's phone", host: notifications, page: "notifications.settings", guest: push, oldPage: "push.settings", row: "setting-push-content" },
    { name: "Source control takes Review's settings", host: workspace, page: "workspace.source-control", guest: review, oldPage: "review.settings", row: "setting-review-propose" },
    { name: "Screenshots takes SnapShots", host: evidence, page: "evidence", guest: snapshots, oldPage: "snapshots.settings", row: "setting-snapshots-enabled" },
  ];
  for (const { name, host, page, guest, oldPage, row } of merges) {
    it(`${name}, and not without it`, async () => {
      const { registry } = createKitHarness(answer);
      registry.activate(host);
      const contribution = registry.getSettingsPages().find((entry) => entry.id === page)!;
      expect(contribution, page).toBeTruthy();
      const alone = renderKitSettingsPage(contribution.Component, { registry });
      expect(document.getElementById(row)).toBeNull();
      alone.unmount();

      registry.activate(guest);
      expect(registry.settingsPageReplacedBy(oldPage)).toBe(page);
      renderKitSettingsPage(contribution.Component, { registry });
      await waitFor(() => expect(document.getElementById(row), row).toBeTruthy());
    });
  }
});
