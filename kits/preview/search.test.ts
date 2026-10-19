import { describe, expect, it } from "vitest";
import { DEFAULT_SEARCH, SEARCH_ENGINES, looksLikeAddress, readSearch, resolveTypedInput, searchTemplateProblem, searchUrl } from "./search.js";

describe("what the address bar treats as an address", () => {
  const addresses = [
    "localhost", "localhost:5173", "LOCALHOST:3000/app", "127.0.0.1", "127.0.0.1:9877/x", "192.168.0.10:8080", "[::1]:3000",
    "my-app.test", "example.com", "www.example.com/a b".replace(" ", "%20"), "docs.python.org/3/", "example.com?q=1", "nas:8080",
    "bun.sh/docs", "https://example.com/a", "http://localhost:3000", "file:///project/dist/index.html", "about:blank",
    "javascript:alert(1)", "data:text/html,hi", "/project/dist/index.html", "/project/my dir/index.html", "C:\\work\\site\\index.html",
    "file:///project/my dir/index.html", "http://example.com/a b",
  ];
  const searches = [
    "foo bar", "what is a.b", "react useEffect cleanup", "?query", "?localhost", "react", "a.b", "3.14", "1.2.3", "README.md", "app.js",
    "std::vector", "foo:bar", "how to: x", "javascript: alert(1)", "example.com is down", "999.1.1.1", "my_app.test",
  ];

  it.each(addresses)("opens %s", (input) => expect(looksLikeAddress(input)).toBe(true));
  it.each(searches)("searches for %s", (input) => expect(looksLikeAddress(input)).toBe(false));

  it("leaves an empty input to the URL check", () => expect(looksLikeAddress("  ")).toBe(true));
});

describe("search URLs", () => {
  it("encodes the query for every engine", () => {
    for (const engine of SEARCH_ENGINES) {
      const url = new URL(searchUrl("a&b=c d/é#1", { engine: engine.id, custom: "" }));
      expect(url.protocol).toBe("https:");
      expect([...url.searchParams.values()]).toEqual(["a&b=c d/é#1"]);
    }
    expect(searchUrl("react useEffect cleanup")).toBe("https://duckduckgo.com/?q=react%20useEffect%20cleanup");
    expect(searchUrl("x", { engine: "kagi", custom: "" })).toBe("https://kagi.com/search?q=x");
  });

  it("uses a valid custom template and falls back to DuckDuckGo for a broken one", () => {
    expect(searchUrl("a b", { engine: "custom", custom: "https://example.com/s/%s/index" })).toBe("https://example.com/s/a%20b/index");
    expect(searchUrl("a b", { engine: "custom", custom: "http://example.com/?q=%s" })).toBe("https://duckduckgo.com/?q=a%20b");
    expect(searchUrl("a b", { engine: "custom", custom: "" })).toBe("https://duckduckgo.com/?q=a%20b");
  });

  it("reads the setting without trusting it", () => {
    expect(readSearch("google", " https://x.test/?q=%s ")).toEqual({ engine: "google", custom: "https://x.test/?q=%s" });
    expect(readSearch("altavista", 5)).toEqual(DEFAULT_SEARCH);
    expect(readSearch(undefined, undefined)).toEqual(DEFAULT_SEARCH);
  });
});

describe("custom search address", () => {
  it("accepts https with %s in the path or query", () => {
    expect(searchTemplateProblem("https://example.com/search?q=%s")).toBeUndefined();
    expect(searchTemplateProblem(" https://example.com/%s ")).toBeUndefined();
  });

  it.each([
    ["https://example.com/search", /%s/u],
    ["http://example.com/?q=%s", /https/u],
    ["ftp://example.com/?q=%s", /https/u],
    ["javascript:%s", /web address|https/u],
    ["https://%s.example.com/", /host/u],
    ["https://user:%s@example.com/", /host/u],
    ["example.com/?q=%s", /web address/u],
  ])("refuses %s", (template, problem) => expect(searchTemplateProblem(template)).toMatch(problem));
});

describe("typed input", () => {
  it("passes an address through and turns anything else into a search", () => {
    expect(resolveTypedInput(" localhost:5173 ", DEFAULT_SEARCH)).toBe("localhost:5173");
    expect(resolveTypedInput("foo bar", { engine: "google", custom: "" })).toBe("https://www.google.com/search?q=foo%20bar");
    expect(resolveTypedInput("?localhost", DEFAULT_SEARCH)).toBe("https://duckduckgo.com/?q=localhost");
  });
});
