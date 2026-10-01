// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createKitHarness } from "../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../src/renderer/test-support/test-providers.js";
import type { DesktopExtension } from "tau";
import { resumeCompactionExtension } from "./resume-compaction/desktop.js";
import { terminalExtension } from "./terminal/desktop.js";
import { workspaceExtension } from "./workspace/desktop.js";

afterEach(cleanup);

const PAGES = ["general", "connections"] as const;

/** General and Connections rows of the kits: each is found by the search and has the element it scrolls to. */
describe("Settings search finds the kits' rows", () => {
  const cases: Array<[string, DesktopExtension, string[]]> = [
    ["Workspace Kit", workspaceExtension, ["Branch name", "Trace tabs", "Editor", "Worktrees under"]],
    ["Resume Compaction", resumeCompactionExtension, ["Compact context"]],
    ["Terminal Kit", terminalExtension, ["Shell"]],
  ];
  for (const [name, extension, labels] of cases) {
    it(`${name}: ${labels.join(", ")}`, async () => {
      const { registry } = createKitHarness();
      registry.activate(extension);
      const sections = PAGES.flatMap((page) => registry.getSettingsSections(page));
      const rows = sections.flatMap((section) => section.rows ?? []);
      for (const label of labels) expect(rows.map((row) => row.label), label).toContain(label);
      const view = render(<TestProviders>{sections.map((section) => <section.Component key={section.id} onNotify={() => undefined} onChanged={() => undefined} />)}</TestProviders>);
      await waitFor(() => { for (const row of rows) expect(view.baseElement.querySelector(`#${row.id}`), row.id).toBeTruthy(); });
    });
  }
});
