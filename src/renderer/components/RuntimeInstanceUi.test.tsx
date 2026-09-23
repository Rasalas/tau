// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeInstanceDialog, RuntimeInstanceSetup, RuntimeVersionBanner } from "./RuntimeInstanceUi";

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
    const { rerender } = render(<RuntimeInstanceSetup {...common} instance={{ id: "default", label: "Codex" }} instances={[{ id: "default" }]} onSave={async () => undefined} />);
    expect(screen.getByRole("button", { name: /Add instance/u })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    rerender(<RuntimeInstanceSetup {...common} instance={{ id: "work", label: "Codex · Work", threads: 1, args: "--x" }} instances={[{ id: "default" }, { id: "work" }]} onSave={async () => undefined} onRemove={onRemove} />);
    expect(screen.queryByRole("button", { name: /Add instance/u })).toBeNull();
    expect(screen.getByText("arguments --x")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText(/Its 1 thread leave the thread list/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove instance" }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1));
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
