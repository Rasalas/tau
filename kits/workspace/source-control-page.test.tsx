// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { missingSettingsRows, renderKitSettingsPage } from "../../src/renderer/test-support/kit-settings-page.js";
import { SOURCE_CONTROL_SETTINGS_ROWS, SourceControlPage } from "./source-control-page.js";

afterEach(cleanup);

const key = (name: string) => `tau.workspace.${name}`;

describe("Settings → Source control", () => {
  it("chooses where new threads run, how submodules fill and where projects start", async () => {
    const { updates, cleared } = renderKitSettingsPage(SourceControlPage, { host: { values: { [key("worktree-submodules")]: "none" } } });

    const modes = screen.getByRole("radiogroup", { name: "New threads run in" });
    expect(within(modes).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Current checkout", "A new worktree"]);
    fireEvent.click(within(modes).getByRole("radio", { name: "A new worktree" }));
    await waitFor(() => expect(updates).toContainEqual({ values: { [key("new-thread-workspace")]: "worktree" } }));

    const submodules = screen.getByRole("combobox", { name: "Submodules" }) as HTMLSelectElement;
    await waitFor(() => expect(submodules.value).toBe("none"));
    // The project file is no value of its own: choosing it clears this machine's.
    fireEvent.change(submodules, { target: { value: "" } });
    await waitFor(() => expect(cleared).toContainEqual([`values.${key("worktree-submodules")}`]));

    fireEvent.click(screen.getByRole("switch", { name: "Keep the default branch current" }));
    await waitFor(() => expect(updates).toContainEqual({ options: { [key("auto-pull-default-branch")]: true } }));

    const folder = screen.getByRole("textbox", { name: "Add project starts in" });
    fireEvent.change(folder, { target: { value: "  ~/code  " } });
    fireEvent.keyDown(folder, { key: "Enter" });
    await waitFor(() => expect(updates).toContainEqual({ values: { [key("project-base-directory")]: "~/code" } }));
    expect(missingSettingsRows({ rows: SOURCE_CONTROL_SETTINGS_ROWS })).toEqual([]);
  });
});
