// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ExtensionRegistry, type PageContribution, type WorkbenchActions } from "../extension-system";
import { SettingsPageAction } from "../settings/page-action";
import { AppPageStore } from "../../workbench/app-page-store";
import { AppPageScreen } from "./AppPageScreen";

afterEach(cleanup);

function setup(page: Partial<PageContribution> = {}, options: { stacked?: boolean } = {}) {
  const registry = new ExtensionRegistry();
  registry.activate({ id: "test.pages", name: "Pages", activate: (context) => {
    context.registerPage({
      id: "reports",
      label: "Reports",
      description: "What the threads reported, per project.",
      Component: ({ params }) => (
        <div>
          <SettingsPageAction><button type="button">Read again</button></SettingsPageAction>
          <p>{params.report ? `Report ${String(params.report)}` : "All reports"}</p>
        </div>
      ),
      ...page,
    });
  } });
  const store = new AppPageStore();
  store.open("reports");
  const view = render(<AppPageScreen registry={registry} store={store} actions={{} as WorkbenchActions} stacked={options.stacked ?? false} />);
  return { store, ...view };
}

/** Every list outside the head's breadcrumb, whose rules drop the markers. */
function unstyledLists(container: HTMLElement): Element[] {
  return [...container.querySelectorAll("ol, ul")].filter((list) => !list.matches(".settings-page-head > nav > ol"));
}

describe("AppPageScreen's head", () => {
  it("heads the page like a Settings page: title, description and its action, and no list in the bar", () => {
    const { container } = setup();
    const head = container.querySelector(".settings-content > .settings-page-head") as HTMLElement;
    expect(head).toBeTruthy();
    expect(within(head).getByRole("heading", { level: 1, name: "Reports" })).toBeTruthy();
    expect(within(head).getByText("What the threads reported, per project.")).toBeTruthy();
    expect(within(head.querySelector(".settings-page-action") as HTMLElement).getByRole("button", { name: "Read again" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    // The bar is the strip the window is dragged by: no title, no list marker before one.
    const bar = container.querySelector(".app-page-bar") as HTMLElement;
    expect(bar.children).toHaveLength(0);
    expect(head.querySelector("nav")).toBeNull();
    expect(unstyledLists(container)).toEqual([]);
  });

  it("titles a view with its label under a breadcrumb that steps back", () => {
    const { store, container } = setup();
    act(() => store.navigate({ report: 1 }, { label: "Weekly" }));
    act(() => store.navigate({ report: 2 }, { label: "Monday" }));
    const head = container.querySelector(".settings-page-head") as HTMLElement;
    expect(within(head).getByRole("heading", { level: 1, name: "Monday" })).toBeTruthy();
    expect(within(head).queryByText("What the threads reported, per project.")).toBeNull();
    const crumbs = within(head).getByRole("navigation");
    expect(within(crumbs).getAllByRole("button").map((button) => button.textContent)).toEqual(["Reports", "Weekly"]);
    expect(unstyledLists(container)).toEqual([]);

    fireEvent.click(within(crumbs).getByRole("button", { name: "Weekly" }));
    expect(store.getSnapshot()?.views.map((view) => view.label)).toEqual([undefined, "Weekly"]);
    fireEvent.click(within(container.querySelector(".settings-page-head nav") as HTMLElement).getByRole("button", { name: "Reports" }));
    expect(store.getSnapshot()?.views).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Reports" })).toBeTruthy();
  });

  it("puts a filling page's head over the area it scrolls itself", () => {
    const { container } = setup({ layout: "fill" });
    const main = container.querySelector(".settings-main") as HTMLElement;
    expect([...main.children].map((child) => child.className)).toEqual(["settings-topbar app-page-bar", "app-page-head", "app-page-fill"]);
    expect(within(main.querySelector(".app-page-head") as HTMLElement).getByRole("heading", { level: 1, name: "Reports" })).toBeTruthy();
    expect(within(main.querySelector(".settings-page-action") as HTMLElement).getByRole("button", { name: "Read again" })).toBeTruthy();
  });

  it("titles a phone's page in its bar, with the rest of the head on top of the page", () => {
    const { store, container } = setup({}, { stacked: true });
    const bar = container.querySelector(".app-page-bar") as HTMLElement;
    expect(within(bar).getByRole("heading", { level: 1, name: "Reports" })).toBeTruthy();
    const head = container.querySelector(".settings-page-head") as HTMLElement;
    expect(within(head).queryByRole("heading")).toBeNull();
    expect(within(head).getByText("What the threads reported, per project.")).toBeTruthy();
    expect(within(head).getByRole("button", { name: "Read again" })).toBeTruthy();

    act(() => store.navigate({ report: 1 }, { label: "Weekly" }));
    expect(within(bar).getByRole("heading", { level: 1, name: "Weekly" })).toBeTruthy();
    expect(within(bar).getByRole("button", { name: "Back to Reports" })).toBeTruthy();
    expect(container.querySelector(".settings-page-head nav")).toBeNull();
    expect(unstyledLists(container)).toEqual([]);
  });

  it("keeps Settings' spacing: the empty bar is Settings' strip and the head lines up with the page", async () => {
    const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//gu, "");
    const rules = (css: string) => [...strip(css).matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map(([, selectors, body]) => ({ selectors: selectors!.trim(), body: body! }));
    const page = rules(await readFile(resolve(__dirname, "app-page.css"), "utf8"));
    const settings = rules(await readFile(resolve(__dirname, "../settings/settings.css"), "utf8"));
    const rule = (list: typeof page, selector: string) => list.find((entry) => entry.selectors === selector)?.body ?? "";

    // The bar only grows once it holds Back or a title; empty, it is Settings' drag strip.
    expect(page.filter((entry) => entry.selectors.includes(".app-page-bar") && /(^|[\s;])height:/u.test(entry.body)).map((entry) => entry.selectors)).toEqual([".app-page-bar:has(> *)"]);
    expect(rule(settings, ".settings-topbar")).toMatch(/height: var\(--space-8\)/u);
    // A filling page's head has the reading column's inset, and the breadcrumb drops its markers.
    expect(rule(page, ".app-page-head")).toMatch(/padding: var\(--space-2\) var\(--space-7\)/u);
    expect(rule(settings, ".settings-content")).toMatch(/padding: var\(--space-2\) var\(--space-7\)/u);
    expect(rule(settings, ".settings-page-head ol")).toMatch(/list-style: none/u);
  });
});

describe("a page still on its way", () => {
  it("says it is loading while the packages load, and that it is gone once they have", () => {
    const registry = new ExtensionRegistry();
    registry.setLoadingExtensions(true);
    const store = new AppPageStore();
    store.open("later");
    render(<AppPageScreen registry={registry} store={store} actions={{} as WorkbenchActions} stacked />);
    expect(screen.getByRole("status").textContent).toBe("Loading …");
    act(() => registry.setLoadingExtensions(false));
    expect(screen.getByText("This page is gone; its extension may have been turned off.")).toBeTruthy();
  });
});
