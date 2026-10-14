import { describe, expect, it } from "vitest";
import { linkRoute, readRoute, routeSearch } from "./routes";

describe("app routes", () => {
  it("round-trips every place through the address", () => {
    for (const search of ["?host=h-1&thread=t-2", "?host=h-1", "?host=h-1&page=usage", "?view=add", "?view=hosts", ""]) {
      expect(routeSearch(readRoute(search))).toBe(search);
    }
    expect(readRoute("?view=other")).toEqual({ view: "hosts", explicit: false });
  });

  it("opens a paired host's thread from a link, and nothing else", () => {
    expect(linkRoute("tau://thread?host=h-1&thread=t-2")).toEqual({ view: "workbench", hostId: "h-1", threadId: "t-2" });
    expect(linkRoute("tau://thread?host=h-1")).toEqual({ view: "workbench", hostId: "h-1" });
    expect(linkRoute("tau://hosts")).toEqual({ view: "hosts", explicit: true });
    expect(linkRoute("tau://usage?host=h-1")).toEqual({ view: "workbench", hostId: "h-1", page: "usage" });
    expect(linkRoute("tau://usage")).toBeUndefined();
    expect(linkRoute("tau://pair?code=secret")).toBeUndefined();
    expect(linkRoute("tau://thread?thread=t")).toBeUndefined();
    expect(linkRoute("https://evil.example/thread?host=h")).toBeUndefined();
    expect(linkRoute("not a url")).toBeUndefined();
  });
});

it("carries bounded prompt links through cold start and navigation", () => {
  const route = linkRoute("tau://new?host=h-1&prompt=%2Fdeploy&project=ws&provider=p&model=m&send=true")!;
  expect(route).toEqual({ view: "workbench", hostId: "h-1", promptLink: {
    hostId: "h-1", prompt: "/deploy", project: "ws", provider: "p", model: "m", truncated: false,
  } });
  expect(readRoute(routeSearch(route))).toEqual(route);
  expect(routeSearch(route)).not.toContain("send");
  const long = linkRoute(`tau://new?host=h&prompt=${"x".repeat(8_001)}`)!;
  expect(readRoute(routeSearch(long))).toEqual(long);
  expect(linkRoute("tau://new?prompt=Hello")).toEqual({ view: "prompt", promptLink: { prompt: "Hello", truncated: false } });
});
