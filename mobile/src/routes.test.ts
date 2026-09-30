import { describe, expect, it } from "vitest";
import { linkRoute, readRoute, routeSearch } from "./routes";

describe("app routes", () => {
  it("round-trips every place through the address", () => {
    for (const search of ["?host=h-1&thread=t-2", "?host=h-1", "?view=add", "?view=hosts", ""]) {
      expect(routeSearch(readRoute(search))).toBe(search);
    }
    expect(readRoute("?view=other")).toEqual({ view: "hosts", explicit: false });
  });

  it("opens a paired host's thread from a link, and nothing else", () => {
    expect(linkRoute("tau://thread?host=h-1&thread=t-2")).toEqual({ view: "workbench", hostId: "h-1", threadId: "t-2" });
    expect(linkRoute("tau://thread?host=h-1")).toEqual({ view: "workbench", hostId: "h-1" });
    expect(linkRoute("tau://hosts")).toEqual({ view: "hosts", explicit: true });
    expect(linkRoute("tau://pair?code=secret")).toBeUndefined();
    expect(linkRoute("tau://thread?thread=t")).toBeUndefined();
    expect(linkRoute("https://evil.example/thread?host=h")).toBeUndefined();
    expect(linkRoute("not a url")).toBeUndefined();
  });
});
