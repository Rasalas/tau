// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DangerAction, ListField, NumberField, SegmentedControl, Select, SettingsState, Slider, Switch, TextField, ValueList, numberProblem } from "./controls";

afterEach(cleanup);

describe("Switch", () => {
  it("is a named switch that says whether it is on", () => {
    const onChange = vi.fn();
    render(<Switch label="Show costs" checked={false} onChange={onChange} />);
    const control = screen.getByRole("switch", { name: "Show costs" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("SegmentedControl", () => {
  function Choice({ onChange = vi.fn() }: { onChange?: (value: string) => void }) {
    const [value, setValue] = useState("b");
    return <SegmentedControl label="Letter" value={value} options={[{ value: "a", label: "A" }, { value: "b", label: "B" }, { value: "c", label: "C", disabled: true }, { value: "d", label: "Dee", icon: <i /> }]}
      onChange={(next) => { setValue(next); onChange(next); }} />;
  }

  it("is a radio group: one stop in the tab order, arrows move and choose, disabled choices are skipped", () => {
    render(<Choice />);
    const group = screen.getByRole("radiogroup", { name: "Letter" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1, -1]);
    fireEvent.keyDown(radios[1]!, { key: "ArrowRight" });
    expect(within(group).getByRole("radio", { name: "Dee" }).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(within(group).getByRole("radio", { name: "Dee" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(within(group).getByRole("radio", { name: "A" }).getAttribute("aria-checked")).toBe("true");
  });

  it("draws an icon-only choice with its name as the tooltip", () => {
    render(<Choice />);
    expect(screen.getByRole("radio", { name: "Dee" }).getAttribute("data-tooltip")).toBe("Dee");
  });
});

describe("Select", () => {
  it("offers a placeholder while the value is none of the options", () => {
    const onChange = vi.fn();
    render(<Select label="Thinking" value={undefined} options={[{ value: "low", label: "Low" }]} placeholder="Pick one" onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "Thinking" }) as HTMLSelectElement;
    expect(select.value).toBe("");
    fireEvent.change(select, { target: { value: "low" } });
    expect(onChange).toHaveBeenCalledWith("low");
  });
});

describe("NumberField", () => {
  it("writes on Enter, clears when emptied, and keeps a refused draft with the reason", () => {
    const onCommit = vi.fn();
    const onClear = vi.fn();
    render(<NumberField label="Max tokens" value={512} min={1} max={4096} integer unit="tokens" onCommit={onCommit} onClear={onClear} />);
    const field = screen.getByRole("spinbutton", { name: "Max tokens" }) as HTMLInputElement;
    expect(screen.getByText("tokens")).toBeTruthy();
    fireEvent.change(field, { target: { value: "1024" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith(1024);

    fireEvent.change(field, { target: { value: "2.5" } });
    fireEvent.blur(field);
    expect(field.value).toBe("2.5");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Enter a whole number.");
    expect(onCommit).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(field, { key: "Escape" });
    expect(field.value).toBe("512");
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("steps with the arrow keys within its range", () => {
    render(<NumberField label="Temperature" value={1.9} min={0} max={2} step={0.1} onCommit={vi.fn()} />);
    const field = screen.getByRole("spinbutton", { name: "Temperature" }) as HTMLInputElement;
    fireEvent.keyDown(field, { key: "ArrowUp" });
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.value).toBe("2");
  });

  it("says what range it takes", () => {
    expect(numberProblem("5", { min: 0, max: 2 })).toBe("Enter a number from 0 to 2.");
    expect(numberProblem("-1", { min: 0 })).toBe("Enter 0 or more.");
    expect(numberProblem("x", {})).toBe("Enter a number.");
    expect(numberProblem("", { clearable: false })).toBe("Enter a number.");
    expect(numberProblem("1.5", { min: 0, max: 2 })).toBeUndefined();
  });
});

describe("TextField", () => {
  it("writes what `validate` accepts and keeps what it refuses", () => {
    const onCommit = vi.fn();
    render(<TextField label="Font" value="" validate={(text) => (text.includes(";") ? "No semicolons." : undefined)} onCommit={onCommit} />);
    const field = screen.getByRole("textbox", { name: "Font" }) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Iosevka;" } });
    fireEvent.blur(field);
    expect(screen.getByRole("alert").textContent).toBe("No semicolons.");
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "Iosevka" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("Iosevka");
  });

  it("with several rows, takes Return as a line break and writes on ⌘Return or blur", () => {
    const onCommit = vi.fn();
    render(<TextField label="Instructions" value="" rows={3} onCommit={onCommit} />);
    const box = screen.getByRole("textbox", { name: "Instructions" });
    expect(box.tagName).toBe("TEXTAREA");
    fireEvent.change(box, { target: { value: "one\ntwo" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(onCommit).toHaveBeenCalledWith("one\ntwo");
  });
});

describe("Slider", () => {
  it("follows the thumb beside the track and writes once the move ends", () => {
    const onCommit = vi.fn();
    const onPreview = vi.fn();
    render(<Slider label="Contrast" value={20} min={0} max={100} step={5} unit="%" onCommit={onCommit} onPreview={onPreview} />);
    const slider = screen.getByRole("slider", { name: "Contrast" }) as HTMLInputElement;
    expect(slider.getAttribute("aria-valuetext")).toBe("20%");
    fireEvent.change(slider, { target: { value: "35" } });
    expect(onPreview).toHaveBeenCalledWith(35);
    expect(onCommit).not.toHaveBeenCalled();
    expect(slider.getAttribute("aria-valuetext")).toBe("35%");
    expect(slider.style.getPropertyValue("--fill")).toBe("35%");
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    expect(onCommit).toHaveBeenCalledWith(35);
  });

  it("reads a value through `format` and writes nothing when the thumb comes back", () => {
    const onCommit = vi.fn();
    render(<Slider label="Panel animations" value={120} min={0} max={400} step={20} format={(ms) => (ms === 0 ? "Off" : `${ms} ms`)} onCommit={onCommit} />);
    const slider = screen.getByRole("slider", { name: "Panel animations" });
    fireEvent.change(slider, { target: { value: "0" } });
    expect(slider.getAttribute("aria-valuetext")).toBe("Off");
    fireEvent.change(slider, { target: { value: "120" } });
    fireEvent.pointerUp(slider);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe("ListField", () => {
  it("adds, refuses a twin and removes by name", () => {
    function List() {
      const [items, setItems] = useState<string[]>(["a.local"]);
      return <ListField label="Hosts" items={items} onChange={setItems} />;
    }
    render(<List />);
    const input = screen.getByRole("textbox", { name: "Add to Hosts" });
    fireEvent.change(input, { target: { value: "a.local" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("alert").textContent).toBe("It is on the list already.");
    fireEvent.change(input, { target: { value: "b.local" } });
    fireEvent.submit(input.closest("form")!);
    expect(screen.getByText("b.local")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove a.local" }));
    expect(screen.queryByText("a.local")).toBeNull();
  });

  it("says so while it is empty", () => {
    render(<ListField label="Hosts" items={[]} empty="No host yet." onChange={vi.fn()} />);
    expect(screen.getByText("No host yet.")).toBeTruthy();
  });
});

describe("DangerAction", () => {
  it("asks first, and with `confirmText` only lets the typed name through", () => {
    const onConfirm = vi.fn();
    render(<DangerAction title="Remove Hello" actionLabel="Remove…" confirmTitle="Remove Hello?" confirmMessage="It is deleted." confirmText="Hello" onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
    const dialog = screen.getByRole("dialog", { name: "Remove Hello?" });
    const confirm = within(dialog).getByRole("button", { name: "Remove" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Hello" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsState and ValueList", () => {
  it("offers another try after an error, and names what loads", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<SettingsState kind="error" title="Clients did not load" description="The host did not answer." onRetry={onRetry} />);
    expect(screen.getByRole("alert").textContent).toContain("Clients did not load");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalled();
    rerender(<SettingsState kind="loading" title="Loading clients" />);
    expect(screen.getByRole("status", { name: "Loading clients" }).getAttribute("aria-busy")).toBe("true");
  });

  it("lays out facts as a description list with a copy button where asked", () => {
    render(<ValueList label="Details" items={[{ label: "Version", value: "1.0.0", mono: true }, { label: "ID", value: "acme.x", copy: "acme.x" }]} />);
    expect(screen.getAllByRole("term").map((term) => term.textContent)).toEqual(["Version", "ID"]);
    expect(screen.getByRole("button", { name: "Copy ID" })).toBeTruthy();
  });
});
