// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContributionOwner, ProjectSourceContribution, ProjectSourceProps, WorkbenchActions } from "../extension-system";
import { ProjectSourcesModal } from "./ProjectSources";
import { useEscapeLayer } from "./ui/escape-layers";

afterEach(cleanup);

const owner: ContributionOwner = { extensionId: "test", extensionName: "Test" };

/** A source view with a menu of its own, as the folder picker has. */
function RemoteSource(_props: ProjectSourceProps) {
  const [menu, setMenu] = useState(false);
  useEscapeLayer(() => setMenu(false), menu);
  return <div>
    <input aria-label="Repository URL" autoFocus />
    <button type="button" onClick={() => setMenu(true)}>Options</button>
    {menu ? <p>Options open</p> : null}
  </div>;
}

const sources: Array<ProjectSourceContribution & ContributionOwner> = [
  { ...owner, id: "test.remote", label: "Remote repository", description: "Clone from a URL", glyph: "R", Component: RemoteSource },
  { ...owner, id: "test.run", label: "Run source", description: "Runs at once", glyph: "S", run: () => false },
];

function Harness({ onClose }: { onClose(): void }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Add project…</button>
    {open ? <ProjectSourcesModal actions={{} as WorkbenchActions} sources={sources} onClose={() => { onClose(); setOpen(false); }} /> : null}
  </>;
}

describe("ProjectSourcesModal", () => {
  it("keeps Tab inside, closes one layer per Escape and gives focus back", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = screen.getByRole("button", { name: "Add project…" });
    act(() => { trigger.focus(); });
    fireEvent.click(trigger);
    const search = screen.getByRole("textbox", { name: "Search project sources" });
    expect(document.activeElement).toBe(search);

    const rows = screen.getAllByRole("button").filter((button) => button.closest(".project-source-list"));
    act(() => { rows.at(-1)!.focus(); });
    fireEvent.keyDown(rows.at(-1)!, { key: "Tab" });
    expect(document.activeElement).toBe(search);

    fireEvent.click(screen.getByText("Remote repository"));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Repository URL" }));
    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    expect(screen.getByText("Options open")).toBeTruthy();

    // The source's menu closes first, then the source goes back to the list, then the modal closes.
    act(() => { fireEvent.keyDown(document.activeElement!, { key: "Escape" }); });
    expect(screen.queryByText("Options open")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Repository URL" })).toBeTruthy();
    act(() => { fireEvent.keyDown(document.activeElement!, { key: "Escape" }); });
    expect(screen.queryByRole("textbox", { name: "Repository URL" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search project sources" }));
    act(() => { fireEvent.keyDown(document.activeElement!, { key: "Escape" }); });
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
