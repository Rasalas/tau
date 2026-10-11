import { describe, expect, it } from "vitest";
import { formatThreadLink, parseThreadLink } from "./thread-links.js";

describe("thread links", () => {
  it("round-trips an id, with the host when the link leaves the app", () => {
    expect(formatThreadLink("0199-abc", "Fix [the] rail\nplease")).toBe("[Fix the rail please](tau://thread?thread=0199-abc)");
    expect(parseThreadLink("tau://thread?thread=0199-abc")).toEqual({ threadId: "0199-abc" });
    expect(formatThreadLink("t 1", "", "host-1")).toBe("[t 1](tau://thread?host=host-1&thread=t+1)");
    expect(parseThreadLink("tau://thread?host=host-1&thread=t+1")).toEqual({ threadId: "t 1", hostId: "host-1" });
  });

  it("reads the push link's shape and nothing else", () => {
    expect(parseThreadLink("TAU://thread?thread=a")).toEqual({ threadId: "a" });
    expect(parseThreadLink("tau://thread")).toBeUndefined();
    expect(parseThreadLink("tau://thread?thread=")).toBeUndefined();
    expect(parseThreadLink("tau://usage?host=h")).toBeUndefined();
    expect(parseThreadLink("tau://threads?thread=a")).toBeUndefined();
    expect(parseThreadLink("https://example.com/?thread=a")).toBeUndefined();
  });
});
