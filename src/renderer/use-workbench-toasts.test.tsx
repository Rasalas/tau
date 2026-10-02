// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadViewStore } from "../workbench/thread-view-store";
import { ToastStore } from "../workbench/toast-store";
import type { AppUpdate } from "./app-update";
import { useWorkbenchToasts } from "./use-workbench-toasts";

afterEach(cleanup);

describe("the update toast", () => {
  it("offers Restart, then follows the install until the quit, and stays up throughout (K161)", () => {
    const toasts = new ToastStore();
    const view = new ThreadViewStore();
    const install = vi.fn();
    const { rerender } = renderHook((update: AppUpdate) => useWorkbenchToasts({ view, toasts, update }), {
      initialProps: { version: "0.7.23", install } as AppUpdate,
    });
    const toast = () => toasts.getToasts().find((entry) => entry.id === "tau.update");

    expect(toast()).toMatchObject({ title: "Tau 0.7.23 downloaded", description: "Restart to install it.", timeoutMs: 0 });
    const restart = toast()!.actions![0]!;
    expect(restart.keepOpen).toBe(true);
    restart.run();
    expect(install).toHaveBeenCalledOnce();

    rerender({ version: "0.7.25", phase: "downloading", progress: 41, install });
    expect(toast()).toMatchObject({ type: "loading", title: "Downloading Tau 0.7.25…", description: "41% · Tau restarts once it is ready.", actions: [] });

    rerender({ version: "0.7.25", phase: "installing", install });
    expect(toast()).toMatchObject({ title: "Installing Tau 0.7.25", description: "Tau reopens by itself when it is done. This can take a few minutes." });

    // A failed install goes back to the restart.
    rerender({ version: "0.7.23", install });
    expect(toast()).toMatchObject({ title: "Tau 0.7.23 downloaded", actions: [expect.objectContaining({ label: "Restart" })] });
  });
});
