// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PairingWait, TokenGate } from "./TokenGate";

afterEach(cleanup);

/** Everything a person can read or hear on a screen: its text and its labels. */
function spoken(root: HTMLElement): string {
  const labels = [...root.querySelectorAll("[aria-label], [title], [placeholder]")]
    .flatMap((element) => ["aria-label", "title", "placeholder"].map((name) => element.getAttribute(name) ?? ""));
  return [root.textContent ?? "", ...labels].join("\n");
}

it("routes a pasted Connect offer to pairing without treating it as a stored host token", () => {
  const onSubmit = vi.fn(); const onConnect = vi.fn();
  render(<TokenGate onSubmit={onSubmit} onConnect={onConnect} />);
  fireEvent.change(screen.getByLabelText("Access key or Tau Connect link"), { target: { value: " tau-connect:private-offer " } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(onConnect).toHaveBeenCalledWith("tau-connect:private-offer");
  expect(onSubmit).not.toHaveBeenCalled();
});

it("names the key field by its visible label and keeps the key out of sight", () => {
  const onSubmit = vi.fn();
  render(<TokenGate onSubmit={onSubmit} />);
  const field = screen.getByLabelText("Access key") as HTMLInputElement;
  expect(field.getAttribute("aria-label")).toBeNull();
  expect(field.type).toBe("password");
  fireEvent.change(field, { target: { value: " secret " } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(onSubmit).toHaveBeenCalledWith("secret");
});

it("names no host, token or file path, and no step in a console", () => {
  const gate = render(<TokenGate notice="Your computer did not answer." onSubmit={() => {}} onAsk={() => {}} onConnect={() => {}} />);
  expect(screen.getByRole("heading", { name: "Connect to Tau" })).toBeTruthy();
  expect(spoken(gate.container)).not.toMatch(/\bhost\b|token|~\/|\.tau|terminal|console/iu);
  gate.unmount();
  const wait = render(<PairingWait verification="123456" onCancel={() => {}} />);
  expect(screen.getByLabelText("Code to compare").textContent).toBe("123 456");
  expect(spoken(wait.container)).not.toMatch(/\bhost\b|token|pairing code/iu);
  wait.rerender(<PairingWait onCancel={() => {}} />);
  expect(screen.getByText("Asking your computer…")).toBeTruthy();
});

it("asks the owner to allow the request on the computer", () => {
  const onAsk = vi.fn();
  render(<TokenGate onSubmit={() => {}} onAsk={onAsk} />);
  fireEvent.click(screen.getByRole("button", { name: "Ask to connect" }));
  expect(onAsk).toHaveBeenCalledOnce();
  expect(screen.getByText(/Compare the codes, then allow it there/u)).toBeTruthy();
});
