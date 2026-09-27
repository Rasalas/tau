// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderCardContext } from "../settings/provider-card-state";
import { RuntimeCommandRow, RuntimeInstanceDialog, RuntimeInstanceSetup, RuntimeProgramRows, RuntimeVersionBanner, programBadge } from "./RuntimeInstanceUi";

afterEach(cleanup);

const common = { program: "Codex", homeVariable: "CODEX_HOME", homePlaceholder: "~/.codex", commandPlaceholder: "codex" };

describe("RuntimeInstanceDialog", () => {
  it("refuses a taken id only once the user tried to add, and keeps a failed save open", async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error("No executable at \"nowhere\".")).mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<RuntimeInstanceDialog {...common} takenIds={["default", "work"]} onSave={onSave} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Work" } });
    expect(screen.queryByText(/exists already/u)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add instance" }));
    expect(screen.getByText("An instance “work” exists already.")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Instance id"), { target: { value: "work-2" } });
    fireEvent.change(screen.getByLabelText("Executable"), { target: { value: "nowhere" } });
    fireEvent.change(screen.getByLabelText("Launch arguments"), { target: { value: " --flag " } });
    fireEvent.click(screen.getByRole("button", { name: "Add instance" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "No executable at \"nowhere\".");
    expect(onSave).toHaveBeenCalledWith({ id: "work-2", name: "Work", command: "nowhere", args: "--flag" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Add instance" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("edits an instance without offering to change its id", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<RuntimeInstanceDialog {...common} instance={{ id: "work", name: "Work", home: "~/.codex-work", env: { A: "1" } }} takenIds={["default", "work"]} onSave={onSave} onClose={() => undefined} />);
    expect(screen.getByRole("dialog", { name: "Edit Work" })).toBeTruthy();
    expect(screen.queryByLabelText("Instance id")).toBeNull();
    expect((screen.getByLabelText("Environment") as HTMLTextAreaElement).value).toBe("A=1");
    fireEvent.change(screen.getByLabelText("Home folder"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ id: "work", name: "Work", env: { A: "1" } }));
  });
});

describe("RuntimeInstanceSetup", () => {
  it("offers another instance on the default card only, and asks before removing one", async () => {
    const onRemove = vi.fn(async () => undefined);
    const { rerender } = render(<RuntimeInstanceSetup {...common} rowId="setting-codex-setup" instance={{ id: "default", label: "Codex" }} instances={[{ id: "default" }]} onSave={async () => undefined} />);
    expect(screen.getByRole("button", { name: /Add instance/u })).toBeTruthy();
    expect(document.getElementById("setting-codex-setup")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove…" })).toBeNull();
    rerender(<RuntimeInstanceSetup {...common} instance={{ id: "work", label: "Codex · Work", threads: 1, args: "--x" }} instances={[{ id: "default" }, { id: "work" }]} onSave={async () => undefined} onRemove={onRemove} />);
    expect(screen.queryByRole("button", { name: /Add instance/u })).toBeNull();
    expect(screen.getByText("arguments --x")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
    const dialog = screen.getByRole("dialog", { name: "Remove “Codex · Work”?" });
    expect(dialog.textContent).toMatch(/Its 1 thread leave the thread list/u);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove instance" }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1));
  });

  it("says why a removal failed under the setup", async () => {
    render(<RuntimeInstanceSetup {...common} instance={{ id: "work", label: "Codex · Work" }} instances={[{ id: "default" }, { id: "work" }]} onSave={async () => undefined} onRemove={async () => { throw new Error("A thread on it is running."); }} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove instance" }));
    expect((await screen.findByRole("alert")).textContent).toBe("A thread on it is running.");
  });
});

describe("RuntimeProgramRows", () => {
  const rows = (state: Parameters<typeof RuntimeProgramRows>[0]["state"], extra: Partial<Parameters<typeof RuntimeProgramRows>[0]> = {}) => (
    <RuntimeProgramRows program="Codex" idPrefix="setting-codex" state={state} missing="Install it, or set its path below." onCheck={() => undefined} {...extra} />
  );

  it("names what was found and where, checks again, and tells the card's head", () => {
    const slot = vi.fn();
    const onCheck = vi.fn();
    render(<ProviderCardContext.Provider value={slot}>{rows({ found: true, version: "0.154.0", location: "/usr/local/bin/codex" }, { onCheck })}</ProviderCardContext.Provider>);
    expect(document.getElementById("setting-codex-program")?.textContent).toContain("0.154.0 · /usr/local/bin/codex");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onCheck).toHaveBeenCalled();
    expect(slot).toHaveBeenLastCalledWith("program", { label: "Installed", tone: "success" });
  });

  it("offers an update in a terminal and never shows the command", () => {
    const onRunCommand = vi.fn();
    render(rows({ found: true, version: "0.150.0", latest: "0.154.0", updateCommand: "brew upgrade --cask codex" }, { onRunCommand }));
    expect(screen.getByText("Codex 0.154.0 is out; 0.150.0 is installed.")).toBeTruthy();
    expect(screen.queryByText(/brew upgrade/u)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Update in a terminal" }));
    expect(onRunCommand).toHaveBeenCalledWith("brew upgrade --cask codex");
  });

  it("puts a version Tau cannot drive before an update, with the release it was tested with", () => {
    const onRunCommand = vi.fn();
    render(rows({ found: true, version: "0.150.0", latest: "0.154.0", compatibility: { status: "broken", recommendedVersion: "0.154.0", installCommand: "npm install -g @openai/codex@0.154.0" } }, { onRunCommand }));
    expect(document.getElementById("setting-codex-version")?.textContent).toContain("Codex 0.150.0 does not work with Tau");
    expect(document.getElementById("setting-codex-update")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Install 0.154.0 in a terminal" }));
    expect(onRunCommand).toHaveBeenCalledWith("npm install -g @openai/codex@0.154.0");
  });

  it("words the head's badge for each state", () => {
    expect(programBadge(undefined)).toBeUndefined();
    expect(programBadge({ found: false })).toEqual({ label: "Not found", tone: "danger" });
    expect(programBadge({ found: true, unsupported: true })).toEqual({ label: "Too old", tone: "danger" });
    expect(programBadge({ found: true, compatibility: { status: "unsafe" } })).toEqual({ label: "Known problems", tone: "warn" });
    expect(programBadge({ found: true, latest: "2" })).toEqual({ label: "Update available", tone: "neutral" });
    expect(programBadge({ found: true }, "Connected")).toEqual({ label: "Connected", tone: "success" });
  });
});

describe("RuntimeCommandRow", () => {
  it("saves a path when the field is left, and is inert while Tau's environment names it", async () => {
    const onSave = vi.fn();
    const props = { id: "setting-codex-executable", program: "Codex", commandName: "codex", variable: "TAU_CODEX_COMMAND", placeholder: "codex, from your login shell's PATH", onSave };
    const { rerender } = render(<RuntimeCommandRow {...props} known command="codex" />);
    const field = screen.getByRole("textbox", { name: "Codex executable" });
    fireEvent.change(field, { target: { value: " /opt/codex " } });
    fireEvent.blur(field);
    expect(onSave).toHaveBeenCalledWith("/opt/codex");
    rerender(<RuntimeCommandRow {...props} known command="/env/codex" source="env" />);
    expect(screen.getByText("Set by TAU_CODEX_COMMAND in Tau's environment.")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Codex executable" }) as HTMLInputElement).value).toBe("/env/codex");
    expect(screen.getByRole("textbox", { name: "Codex executable" }).closest("[inert]")).toBeTruthy();
  });
});

describe("RuntimeVersionBanner", () => {
  const backend = (status: "supported" | "unsafe" | "broken", installCommand?: string) => ({
    kind: "codex", label: "Codex",
    version: { tool: "codex", installed: "0.150.0", updateCommand: "brew upgrade --cask codex", compatibility: { status, recommendedVersion: "0.154.0", ...(installCommand ? { installCommand } : {}) } },
  });

  it("says nothing about a supported version", () => {
    expect(render(<RuntimeVersionBanner backend={backend("supported")} />).container.firstChild).toBeNull();
  });

  it("names a broken version as an alert, with the release to install and the command that installs it", () => {
    const onInstall = vi.fn();
    render(<RuntimeVersionBanner backend={backend("broken", "npm install -g @openai/codex@0.154.0")} onInstall={onInstall} onDismiss={() => undefined} />);
    expect(screen.getByRole("alert").textContent).toContain("Codex 0.150.0 does not work with Tau");
    expect(screen.getByText(/Tau was tested with 0\.154\.0/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Install 0\.154\.0 in a terminal/u }));
    expect(onInstall).toHaveBeenCalledWith("npm install -g @openai/codex@0.154.0");
  });

  it("falls back to the update command where the release cannot be pinned", () => {
    const onInstall = vi.fn();
    render(<RuntimeVersionBanner backend={backend("unsafe")} onInstall={onInstall} />);
    expect(screen.getByRole("status").textContent).toContain("has known problems");
    fireEvent.click(screen.getByRole("button", { name: /Update in a terminal/u }));
    expect(onInstall).toHaveBeenCalledWith("brew upgrade --cask codex");
    expect(screen.queryByRole("button", { name: /Dismiss/u })).toBeNull();
  });
});
