// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UpdateToast } from "./UpdateToast";

describe("UpdateToast", () => {
  it("names the version and offers the restart that installs it", () => {
    const onRestart = vi.fn();
    render(<UpdateToast version="0.2.0" onRestart={onRestart} onDismiss={vi.fn()} />);

    expect(screen.getByRole("status").textContent).toContain("Tau 0.2.0 downloaded, restart to install");
    screen.getByRole("button", { name: "Restart" }).click();
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("can be dismissed without restarting", () => {
    const onRestart = vi.fn();
    const onDismiss = vi.fn();
    render(<UpdateToast version="0.2.0" onRestart={onRestart} onDismiss={onDismiss} />);

    screen.getByRole("button", { name: "Dismiss" }).click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onRestart).not.toHaveBeenCalled();
  });
});
