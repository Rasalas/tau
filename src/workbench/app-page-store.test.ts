import { describe, expect, it, vi } from "vitest";
import { AppPageStore } from "./app-page-store";

describe("AppPageStore", () => {
  it("opens a page, steps into views and back out", () => {
    const store = new AppPageStore();
    const heard = vi.fn();
    store.subscribe(heard);
    store.open("reports", { range: "7d" });
    store.navigate({ item: 4 }, { label: "#4" });
    store.navigate({ item: 5 }, { label: "#5", replace: true });
    expect(store.getSnapshot()).toEqual({ id: "reports", views: [{ params: { range: "7d" } }, { params: { item: 5 }, label: "#5" }] });
    expect(store.back()).toBe(true);
    expect(store.back()).toBe(false);
    expect(store.getSnapshot()?.views).toEqual([{ params: { range: "7d" } }]);
    store.close();
    expect(store.getSnapshot()).toBeUndefined();
    expect(heard).toHaveBeenCalledTimes(5);
  });

  it("replaces an open page and ignores views without one", () => {
    const store = new AppPageStore();
    store.navigate({ item: 1 });
    expect(store.getSnapshot()).toBeUndefined();
    store.open("a");
    store.navigate({ item: 1 }, { label: "one" });
    store.open("b");
    expect(store.getSnapshot()).toEqual({ id: "b", views: [{ params: {} }] });
    store.navigate({ tab: "x" }, { label: "ignored", replace: true });
    expect(store.getSnapshot()?.views).toEqual([{ params: { tab: "x" } }]);
  });

  it("returns to the page's own view", () => {
    const store = new AppPageStore();
    store.open("a");
    store.navigate({ one: 1 }, { label: "1" });
    store.navigate({ two: 2 }, { label: "2" });
    store.root();
    expect(store.getSnapshot()?.views).toHaveLength(1);
  });

  it("leaves every view for the page's own, opened anew", () => {
    const store = new AppPageStore();
    store.open("a", { tab: "x" });
    store.navigate({ item: 1 }, { label: "1" });
    store.navigate({ tab: "y" }, { root: true, replace: true });
    expect(store.getSnapshot()?.views).toEqual([{ params: { tab: "y" } }]);
  });
});
