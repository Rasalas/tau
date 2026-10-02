// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TokenGate } from "./TokenGate";

afterEach(cleanup);
it("routes a pasted Connect offer to pairing without treating it as a stored host token", () => {
  const onSubmit = vi.fn(); const onConnect = vi.fn();
  render(<TokenGate onSubmit={onSubmit} onConnect={onConnect} />);
  fireEvent.change(screen.getByLabelText("Token"), { target: { value: " tau-connect:private-offer " } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  expect(onConnect).toHaveBeenCalledWith("tau-connect:private-offer");
  expect(onSubmit).not.toHaveBeenCalled();
});
