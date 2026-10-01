// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PrivateAccountText } from "./PrivateAccountText";

afterEach(cleanup);

describe("PrivateAccountText", () => {
  it("keeps surrounding text and hides multiple addresses independently, including international addresses", () => {
    const emails = ["private+work@sub.example.net", "jörg@büro.example"];
    const { container } = render(<PrivateAccountText text={`Pro · ${emails[0]}, ${emails[1]}`} />);
    for (const email of emails) expect(container.innerHTML).not.toContain(email);
    expect(container.textContent).toMatch(/^Pro · user-.*@example.com, user-.*@example.com$/);
    fireEvent.click(screen.getAllByRole("button", { name: "Show email address" })[0]!);
    expect(screen.getByRole("button", { name: "Hide email address", description: emails[0] })).toBeTruthy();
    expect(container.innerHTML).not.toContain(emails[1]);
    fireEvent.click(screen.getByRole("button", { name: "Hide email address" }));
    for (const email of emails) expect(container.innerHTML).not.toContain(email);
  });

  it("conceals a replacement account even when the previous address was revealed", () => {
    const { container, rerender } = render(<PrivateAccountText text="first@example.net" />);
    const placeholder = container.textContent;
    rerender(<PrivateAccountText text="first@example.net" />);
    expect(container.textContent).toBe(placeholder);
    fireEvent.click(screen.getByRole("button", { name: "Show email address" }));
    rerender(<PrivateAccountText text="second@example.net" />);
    expect(screen.getByRole("button", { name: "Show email address" })).toBeTruthy();
    expect(container.innerHTML).not.toContain("second@example.net");
    expect(container.innerHTML).not.toContain("first@example.net");
  });
});
