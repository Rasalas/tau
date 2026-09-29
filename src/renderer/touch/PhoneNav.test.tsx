// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChartColumn } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorage, setClientStorage, type ClientStorage } from "../../workbench/client-storage";
import { ExtensionRegistry } from "../extension-system";
import { storedPageCatalog } from "../../web/page-catalog";
import { getClientStorage } from "../../workbench/client-storage";
import { PhoneNav, phoneNavItems, RegistryPhoneNav, setPageCatalog } from "./PhoneNav";

let storage: ClientStorage;
beforeEach(() => { storage = createMemoryStorage(); setClientStorage(storage); setPageCatalog(storedPageCatalog(getClientStorage)); });
afterEach(() => { cleanup(); setClientStorage(undefined); setPageCatalog(undefined); });

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

  it("has the pages of the last start at once, while the packages are still loading", () => {
    const loaded = new ExtensionRegistry();
    loaded.activate({ id: "test.usage", name: "Usage", activate: (context) => { context.registerPage({ id: "usage", label: "Usage", Icon: ChartColumn, Component: () => null }); } });
    render(<RegistryPhoneNav registry={loaded} current={{ kind: "threads" }} onSelect={() => {}} />);
    const drawn = screen.getByRole("button", { name: "Usage" }).querySelector("svg")!.innerHTML;
    cleanup();

    // The next start: nothing registered yet.
    const starting = new ExtensionRegistry();
    starting.setLoadingExtensions(true);
    const onSelect = vi.fn();
    render(<RegistryPhoneNav registry={starting} current={{ kind: "threads" }} onSelect={onSelect} />);
    const cached = screen.getByRole("button", { name: "Usage" });
    expect(decodeURIComponent((cached.querySelector(".phone-nav-cached-icon") as HTMLElement).style.maskImage)).toContain(drawn);
    fireEvent.click(cached);
    expect(onSelect).toHaveBeenCalledWith({ kind: "page", page: "usage" });

    // Loaded without it (the package was turned off): the remembered page goes.
    act(() => starting.setLoadingExtensions(false));
    expect(screen.queryByRole("button", { name: "Usage" })).toBeNull();
  });

  it("draws a remembered icon as a mask, where its markup cannot run", () => {
    storage.set("tau.page-catalog", JSON.stringify([{ id: "x", label: "X", icon: "<svg onload=\"alert(1)\"><script>alert(2)</script></svg>\")" }]));
    const starting = new ExtensionRegistry();
    starting.setLoadingExtensions(true);
    render(<RegistryPhoneNav registry={starting} current={{ kind: "threads" }} onSelect={() => {}} />);
    const button = screen.getByRole("button", { name: "X" });
    expect(button.querySelector("svg, script")).toBeNull();
    const mask = (button.querySelector(".phone-nav-cached-icon") as HTMLElement).style.maskImage;
    expect(mask.startsWith("url(\"data:image/svg+xml,%3Csvg")).toBe(true);
    expect(mask.slice(5, -2)).not.toMatch(/["<>]/u);
  });
});
