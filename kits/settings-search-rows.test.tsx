// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchShellContext, createKitHarness } from "../src/renderer/test-support/kit-harness.js";
import { TestProviders } from "../src/renderer/test-support/test-providers.js";
import type { DesktopExtension } from "tau";
import { resumeCompactionExtension } from "./resume-compaction/desktop.js";
import { workspaceExtension } from "./workspace/desktop.js";

afterEach(cleanup);

const PAGES = ["general", "threads", "connections"] as const;

/** General, Threads and Connections rows of the kits: each is found by the search and has the element it scrolls to. */
describe("Settings search finds the kits' rows", () => {
  const cases: Array<[string, DesktopExtension, string[]]> = [
    ["Workspace", workspaceExtension, ["Branch name", "Trace tabs", "Editor"]],
    ["Resume Compaction", resumeCompactionExtension, ["Compact context"]],
  ];
  for (const [name, extension, labels] of cases) {
    it(`${name}: ${labels.join(", ")}`, async () => {
      const { registry } = createKitHarness();
      registry.activate(extension);
      const sections = PAGES.flatMap((page) => registry.getSettingsSections(page));
      const rows = sections.flatMap((section) => section.rows ?? []);
      for (const label of labels) expect(rows.map((row) => row.label), label).toContain(label);
      const view = render(<TestProviders><WorkbenchShellContext.Provider value={{ registry }}>{sections.map((section) => <section.Component key={section.id} onNotify={() => undefined} onChanged={() => undefined} />)}</WorkbenchShellContext.Provider></TestProviders>);
      await waitFor(() => { for (const row of rows) expect(view.baseElement.querySelector(`#${row.id}`), row.id).toBeTruthy(); });
    });
  }
});
