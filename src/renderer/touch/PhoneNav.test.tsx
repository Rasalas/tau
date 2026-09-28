// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChartColumn } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneNav, phoneNavItems } from "./PhoneNav";

afterEach(cleanup);

const page = (id: string, label: string) => ({ id, label, Icon: ChartColumn, Component: () => null, extensionId: "x", extensionName: "x" });

describe("the phone's bottom navigation", () => {
  it("puts Threads first and Settings last, with three pages at most between", () => {
    const registry = { getPages: () => [page("a", "A"), page("b", "B"), page("c", "C"), page("d", "D")] };
    expect(phoneNavItems(registry).map((item) => item.label)).toEqual(["Threads", "A", "B", "C", "Settings"]);
  });

  it("marks where the phone is and goes elsewhere on a tap", () => {
    const onSelect = vi.fn();
    render(<PhoneNav items={phoneNavItems({ getPages: () => [page("usage", "Usage")] })} current={{ kind: "page", page: "usage" }} onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: "Usage" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Threads" }).hasAttribute("aria-current")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Usage" }));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    expect(onSelect).toHaveBeenCalledWith({ kind: "threads" });
  });

  it("carries a page's count to its tab", () => {
    const counted = { ...page("requests", "Pull requests"), useBadge: () => 2 };
    render(<PhoneNav items={phoneNavItems({ getPages: () => [counted, page("usage", "Usage")] })} current={{ kind: "threads" }} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: "Pull requests, 2" }).querySelector(".page-badge")?.textContent).toBe("2");
    expect(screen.getByRole("button", { name: "Usage" }).querySelector(".page-badge")).toBeNull();
  });
});
