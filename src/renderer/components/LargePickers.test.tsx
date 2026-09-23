// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiModel } from "../../shared/contracts";
import type { WorkbenchActions } from "../extension-system";
import { CommandPalette } from "./CommandPalette";
import { ModelPicker } from "./ModelPicker";
import { TestProviders } from "../test-support/test-providers";

afterEach(cleanup);

const models: UiModel[] = Array.from({ length: 10_000 }, (_, index) => ({
  provider: "provider",
  id: `model-${index}`,
  name: `Model ${index}`,
}));

const commands = Array.from({ length: 10_000 }, (_, index) => ({
  id: `command-${index}`,
  label: `Command ${index}`,
  group: `Group ${index % 10}`,
  extensionId: "fixture",
  extensionName: "Fixture",
  run: vi.fn(),
}));

describe("large picker catalogs", () => {
  it("keeps model search and keyboard selection bounded", () => {
    const onSelect = vi.fn();
    render(<TestProviders><ModelPicker models={models} onSelect={onSelect} onClose={() => {}} anchor={{ current: null }} /></TestProviders>);
    expect(document.querySelectorAll(".model-row").length).toBeLessThan(50);
    const input = screen.getByRole("textbox", { name: "Search models" });
    fireEvent.change(input, { target: { value: "Model 9999" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(models[9999]);
  });

  it("keeps command search and keyboard selection bounded", () => {
    render(<CommandPalette open commands={commands} extensionCount={1} actions={{} as WorkbenchActions} onClose={() => {}} />);
    expect(document.querySelectorAll(".palette-results button").length).toBeLessThan(50);
    const input = screen.getByRole("textbox", { name: "Command" });
    fireEvent.change(input, { target: { value: "Command 9999" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(commands[9999].run).toHaveBeenCalledOnce();
  });
});
