// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandLineState, WindowAction } from "../../shared/window-shell";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { CommandLineRow } from "./CommandLineRow";

afterEach(cleanup);

const FRESH: CommandLineState = { supported: true, name: "tau", onPath: false, target: { folder: "/home/a/.local/bin", onPath: true } };

function setup(initial: CommandLineState | Error, onNotify = vi.fn()) {
  let state = initial;
  const windowAction = vi.fn(async (action: WindowAction) => {
    if (state instanceof Error) throw state;
    if (action.kind === "command-line" && action.op === "install") state = { supported: true, name: "tau", onPath: true, installedPath: `${action.folder}/tau` };
    if (action.kind === "command-line" && action.op === "remove") state = FRESH;
    return state;
  });
  render(<TestProviders><HostClientProvider client={createFakeHostClient({ windowAction })}><CommandLineRow onNotify={onNotify} /></HostClientProvider></TestProviders>);
  return { windowAction, onNotify };
}

describe("Settings → General → Command line", () => {
  it("asks which folder before it links, then offers Remove", async () => {
    const { windowAction } = setup(FRESH);
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    // Nothing is linked until the person agrees.
    expect(windowAction).toHaveBeenCalledTimes(1);
    const dialog = await screen.findByRole("dialog", { name: "Install the tau command?" });
    expect(dialog.textContent).toContain("/home/a/.local/bin");

    fireEvent.click(within(dialog).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(windowAction).toHaveBeenCalledWith({ kind: "command-line", op: "install", folder: "/home/a/.local/bin" }));
    expect(await screen.findByText(/Installed at \/home\/a\/\.local\/bin\/tau\. Open a new terminal/u)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("button", { name: "Install" })).toBeTruthy();
    expect(windowAction).toHaveBeenLastCalledWith({ kind: "command-line", op: "remove" });
  });

  it("says when the folder is not on PATH yet, in the question and after", async () => {
    setup({ ...FRESH, target: { folder: "/home/a/bin", onPath: false } });
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    expect((await screen.findByRole("dialog")).textContent).toContain("not on your PATH yet");
  });

  it("offers no Install where another tau is already on PATH, and says where", async () => {
    setup({ ...FRESH, otherPath: "/usr/bin/tau" });
    expect(await screen.findByText(/already on your PATH at \/usr\/bin\/tau/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
  });

  it("shows nothing where the window cannot link a command", async () => {
    const { windowAction } = setup({ ...FRESH, supported: false });
    await waitFor(() => expect(windowAction).toHaveBeenCalled());
    expect(screen.queryByText("Command line")).toBeNull();
  });

  it("shows nothing where there is no window process, as in a browser tab", async () => {
    const { windowAction } = setup(Object.assign(new Error("No window"), { code: "unsupported" }));
    await waitFor(() => expect(windowAction).toHaveBeenCalled());
    expect(screen.queryByText("Command line")).toBeNull();
  });

  it("tells the person when linking fails", async () => {
    const onNotify = vi.fn();
    const { windowAction } = setup(FRESH, onNotify);
    windowAction.mockImplementation(async (action) => { if (action.kind === "command-line" && action.op === "install") throw new Error("not writable"); return FRESH; });
    fireEvent.click(await screen.findByRole("button", { name: "Install" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(onNotify).toHaveBeenCalledWith("Could not install tau: not writable", "error"));
  });
});
