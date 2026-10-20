// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LoadError } from "./LoadError";

afterEach(cleanup);

it("says what did not load, offers Retry and folds the raw error under Details", () => {
  const onRetry = vi.fn();
  render(<LoadError title="Could not load this diff" error="ECONNRESET: socket hang up" onRetry={onRetry} />);
  const alert = screen.getByRole("alert");
  expect(alert.querySelector("strong")?.textContent).toBe("Could not load this diff");
  const details = alert.querySelector("details");
  expect(details?.open).toBe(false);
  expect(details?.querySelector("summary")?.textContent).toBe("Details");
  expect(details?.querySelector("pre")?.textContent).toBe("ECONNRESET: socket hang up");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it("leaves out Retry and Details when there is nothing to retry or show", () => {
  render(<LoadError title="Could not read the instructions" description="The machine is not connected." />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByRole("alert").querySelector("details")).toBeNull();
  expect(screen.getByText("The machine is not connected.")).toBeTruthy();
});
