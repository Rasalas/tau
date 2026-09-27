import { describe, expect, it } from "vitest";
import { historySteps, routeFromState, routeFromUrl, routePath, stateWithRoute, urlWithRoute } from "./phone-history";
import { PHONE_HOME, phoneTab, showsPhoneNav, type PhoneRoute } from "./phone-route";

const chat = (thread?: string): PhoneRoute => (thread ? { kind: "chat", thread } : { kind: "chat" });
const page = (id: string, depth = 0): PhoneRoute => ({ kind: "page", page: id, depth });
const settings = (section?: string): PhoneRoute => (section ? { kind: "settings", section } : { kind: "settings" });

describe("a phone's routes", () => {
  it("shows the bottom navigation on the main pages only", () => {
    expect([PHONE_HOME, page("usage"), settings()].map(showsPhoneNav)).toEqual([true, true, true]);
    expect([chat("t1"), chat(), page("usage", 1), settings("about")].map(showsPhoneNav)).toEqual([false, false, false, false]);
  });

  it("counts a chat as the list's, a view as its page's, a section as Settings'", () => {
    expect(phoneTab(chat("t1"))).toEqual({ kind: "threads" });
    expect(phoneTab(page("usage", 2))).toEqual({ kind: "page", page: "usage" });
    expect(phoneTab(settings("about"))).toEqual({ kind: "settings" });
  });

  it("leads every route from home", () => {
    expect(routePath(PHONE_HOME)).toEqual([PHONE_HOME]);
    expect(routePath(chat("t1"))).toEqual([PHONE_HOME, chat("t1")]);
    expect(routePath(page("usage", 2))).toEqual([PHONE_HOME, page("usage"), page("usage", 1), page("usage", 2)]);
    expect(routePath(settings("about"))).toEqual([PHONE_HOME, settings(), settings("about")]);
  });
});

describe("history steps", () => {
  it("adds an entry for a sub-page and goes back to leave it", () => {
    expect(historySteps(PHONE_HOME, chat("t1"))).toEqual({ back: 0, push: [chat("t1")] });
    expect(historySteps(chat("t1"), PHONE_HOME)).toEqual({ back: 1, push: [] });
    expect(historySteps(page("usage"), page("usage", 1))).toEqual({ back: 0, push: [page("usage", 1)] });
    expect(historySteps(page("usage", 1), page("usage"))).toEqual({ back: 1, push: [] });
  });

  it("replaces the entry when another thread or destination takes its place", () => {
    expect(historySteps(chat("t1"), chat("t2"))).toEqual({ back: 0, replace: chat("t2"), push: [] });
    expect(historySteps(chat(), chat("t9"))).toEqual({ back: 0, replace: chat("t9"), push: [] });
    expect(historySteps(page("usage"), settings())).toEqual({ back: 0, replace: settings(), push: [] });
  });

  it("goes back to the shared part first when leaving a deeper route for another", () => {
    expect(historySteps(page("pulls", 1), chat("t1"))).toEqual({ back: 1, replace: chat("t1"), push: [] });
    expect(historySteps(settings("about"), PHONE_HOME)).toEqual({ back: 2, push: [] });
    expect(historySteps(PHONE_HOME, settings("about"))).toEqual({ back: 0, push: [settings(), settings("about")] });
  });

  it("does nothing for the same route", () => {
    expect(historySteps(chat("t1"), chat("t1"))).toEqual({ back: 0, push: [] });
  });
});

describe("the address and the entry", () => {
  const base = "https://host.test/app?host=h1#top";

  it("writes the route beside the address's own parameters", () => {
    expect(urlWithRoute(base, chat("t1"))).toBe("/app?host=h1&thread=t1#top");
    expect(urlWithRoute(base, chat())).toBe("/app?host=h1#top");
    expect(urlWithRoute(base, page("usage", 1))).toBe("/app?host=h1&page=usage#top");
    expect(urlWithRoute(base, settings())).toBe("/app?host=h1&settings#top");
    expect(urlWithRoute(`${base.replace("#top", "")}&thread=t1`, PHONE_HOME)).toBe("/app?host=h1");
  });

  it("reads the route a link names", () => {
    expect(routeFromUrl("https://h.test/?thread=t1&page=usage")).toEqual(chat("t1"));
    expect(routeFromUrl("https://h.test/?page=usage")).toEqual(page("usage"));
    expect(routeFromUrl("https://h.test/?settings")).toEqual(settings());
    expect(routeFromUrl("https://h.test/?settings=about")).toEqual(settings("about"));
    expect(routeFromUrl("https://h.test/?host=h1")).toEqual(PHONE_HOME);
  });

  it("keeps the route, a view's depth too, in the entry beside what else it holds", () => {
    const state = stateWithRoute({ other: 1 }, page("usage", 2));
    expect(state.other).toBe(1);
    expect(routeFromState(state)).toEqual(page("usage", 2));
    expect(routeFromState(stateWithRoute(null, chat()))).toEqual(chat());
    expect(routeFromState(null)).toBeUndefined();
    expect(routeFromState({ tauPhoneRoute: { kind: "page" } })).toBeUndefined();
  });
});
