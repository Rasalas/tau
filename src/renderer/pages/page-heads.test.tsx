// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRegistry, type PageContribution, type WorkbenchActions } from "../extension-system";
import { AppPageStore } from "../../workbench/app-page-store";
import { HostClientProvider } from "../host-client-context";
import { PreferencesStore } from "../preferences";
import { SettingsScreen } from "../settings/SettingsScreen";
import { SettingsPageHead } from "../settings/page-head";
import { ThreadHeader } from "../components/ThreadHeader";
import { StageTabs } from "../components/StageTabs";
import { TestProviders } from "../test-support/test-providers";
import { markedLists, parseCssRules, rendererCssRules } from "../test-support/list-markers";
import { AppPageScreen } from "./AppPageScreen";

afterEach(cleanup);

const rules = rendererCssRules();
const text = (lists: Element[]) => lists.map((list) => list.outerHTML.slice(0, 120));

function page(options: { stacked?: boolean; layout?: PageContribution["layout"] } = {}) {
  const registry = new ExtensionRegistry();
  registry.activate({ id: "test.pages", name: "Pages", activate: (context) => {
    context.registerPage({ id: "usage", label: "Usage", description: "What the threads used.", ...(options.layout ? { layout: options.layout } : {}), Component: () => <p>Plan limits</p> });
  } });
  const store = new AppPageStore();
  store.open("usage");
  const view = render(<AppPageScreen registry={registry} store={store} actions={{} as WorkbenchActions} stacked={options.stacked ?? false} />);
  return { store, ...view };
}

describe("page heads and bars draw no list markers", () => {
  it("finds a numbered list where no rule drops its markers, and none in a head or a bar", () => {
    const { container } = render(<>
      <div id="plain"><ol><li>Usage</li></ol></div>
      {/* 0.7.13's app page: a crumb list in the bar whose rules had gone. */}
      <header id="bar" className="settings-topbar"><nav aria-label="Breadcrumb"><ol><li><h1>Usage</h1></li></ol></nav></header>
      <div id="toolbar" role="toolbar"><ul><li>Files</li></ul></div>
    </>);
    expect(markedLists(container.querySelector("#plain")!, rules)).toHaveLength(1);
    // Without the renderer's rules the bar's list would be numbered; with them it is not.
    expect(markedLists(container.querySelector("#bar")!, parseCssRules(""))).toHaveLength(1);
    expect(text(markedLists(container.querySelector("#bar")!, rules))).toEqual([]);
    expect(text(markedLists(container.querySelector("#toolbar")!, rules))).toEqual([]);
  });

  it("an app page's head, its views' breadcrumb, a filling page and a phone's bar", () => {
    const { store, container } = page();
    expect(text(markedLists(container, rules))).toEqual([]);
    act(() => store.navigate({ source: 1 }, { label: "Sources" }));
    act(() => store.navigate({ source: 2 }, { label: "Codex" }));
    expect(container.querySelectorAll(".settings-page-head li")).toHaveLength(2);
    expect(text(markedLists(container, rules))).toEqual([]);
    cleanup();
    expect(text(markedLists(page({ layout: "fill" }).container, rules))).toEqual([]);
    cleanup();
    const phone = page({ stacked: true });
    act(() => phone.store.navigate({ source: 1 }, { label: "Sources" }));
    expect(text(markedLists(phone.container, rules))).toEqual([]);
  });

  it("a Settings page with its breadcrumb, on a desktop and on a phone", () => {
    const head = render(<SettingsPageHead title="Access Kit" description="Asks first." crumbs={[{ label: "Settings", open: vi.fn() }, { label: "Extensions", open: vi.fn() }]} actionSlot={() => undefined} />);
    expect(text(markedLists(head.container, rules))).toEqual([]);
    cleanup();
    for (const stacked of [false, true]) {
      const { container } = render(<HostClientProvider client={undefined}><TestProviders>
        <SettingsScreen page="extensions" stacked={stacked} view="page" registry={new ExtensionRegistry(undefined, { preferences: new PreferencesStore() })} onSetPage={vi.fn()} onSetModel={vi.fn()} onSetThinking={vi.fn()} onClose={vi.fn()} onNotify={vi.fn()} />
      </TestProviders></HostClientProvider>);
      expect(text(markedLists(container, rules))).toEqual([]);
      cleanup();
    }
  });

  it("the thread's header and the stage's tab strip", () => {
    const { container } = render(<>
      <ThreadHeader title="Add pagination" details={<div className="thread-details"><span className="thread-detail">feat/pagination</span><span className="thread-detail">turn 2</span></div>} />
      <StageTabs
        tabs={[{ id: "a", kind: "file", path: "/work/shop-api/src/orders.ts", view: "source", preview: false }]}
        activeId="a"
        changedPaths={new Set(["/work/shop-api/src/orders.ts"])}
        onActivate={vi.fn()} onClose={vi.fn()} onPin={vi.fn()} onUnpin={vi.fn()} onCloseOthers={vi.fn()} onCloseToRight={vi.fn()}
      />
    </>);
    expect(container.querySelector('[role="tablist"]')).toBeTruthy();
    expect(text(markedLists(container, rules))).toEqual([]);
  });
});
