// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { submitOnEnter } from "./dialog-parts";

afterEach(cleanup);

it.each([{ isComposing: true }, { keyCode: 229 }])("does not submit a dialog on IME Enter (%j)", (composition) => {
  const submit = vi.fn();
  render(<div onKeyDown={submitOnEnter(submit)}><input aria-label="Name" /></div>);
  const input = screen.getByRole("textbox", { name: "Name" });
  const allowed = fireEvent.keyDown(input, { key: "Enter", ...composition });
  expect(submit).not.toHaveBeenCalled();
  expect(allowed).toBe(true);
  expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
  expect(submit).toHaveBeenCalledOnce();
});
