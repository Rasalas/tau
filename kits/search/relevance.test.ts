import { describe, expect, it } from "vitest";
import { textMatch, threadRank, tokenRank } from "./relevance.js";
import { queryTokens } from "./threads.js";

describe("literal search relevance", () => {
  it("prefers whole words, then word prefixes, while retaining substring matches", () => {
    expect(tokenRank("Fix auth tokens", "auth")).toBe(3);
    expect(tokenRank("Authentication", "auth")).toBe(2);
    expect(tokenRank("Fix oauth redirect", "auth")).toBe(1);
    expect(tokenRank("Fix tokens", "auth")).toBe(0);
    // Short tokens are still searchable, including in the middle of a word.
    expect(tokenRank("model", "del")).toBe(1);
    expect(tokenRank("anything", "")).toBe(0);
  });

  it("recognizes camel case, acronyms, paths, digits and Unicode word boundaries", () => {
    expect(tokenRank("refreshAuthToken", "auth")).toBe(3);
    expect(tokenRank("JSONSchema", "schema")).toBe(3);
    expect(tokenRank("feature/auth-cleanup", "auth")).toBe(3);
    expect(tokenRank("version42", "42")).toBe(3);
    expect(tokenRank("Über Auth", "auth")).toBe(3);
    expect(tokenRank("Überauth", "auth")).toBe(1);
    expect(tokenRank("Cafe\u0301auth", "auth")).toBe(1);
    expect(tokenRank("更新東京都", "東京")).toBe(3);
    expect(tokenRank("src/parser.tsx", ".ts")).toBe(2);
  });

  it("keeps Unicode folding deterministic and returns source offsets after expanded lowercase", () => {
    const found = textMatch("İİ before auth", queryTokens("auth"));
    expect(found).toMatchObject({ at: 10, length: 4, quality: 31 });
    expect(tokenRank("ΣΟΣ", queryTokens("σος")[0]!)).toBe(3);
    expect(tokenRank("𐐀", queryTokens("𐐨")[0]!)).toBe(3);
    expect(tokenRank("café", "cafe")).toBe(0);
    expect(tokenRank("cafe\u0301", "café")).toBe(0);
  });

  it("ranks exact titles first and keeps mixed title, branch and project queries", () => {
    const tokens = queryTokens("AUTH");
    const scores = [
      threadRank(tokens, "oauth"),
      threadRank(tokens, "Other work", "feature/auth-cleanup"),
      threadRank(tokens, "Fix auth tokens"),
      threadRank(tokens, "  Auth  "),
    ];
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
    expect(new Set(scores).size).toBe(4);
    expect(threadRank(queryTokens("auth tau cleanup"), "Fix auth", "feature/cleanup", "tau")).toBeGreaterThan(0);
    expect(threadRank(queryTokens("auth unknown"), "Fix auth", "cleanup", "tau")).toBe(0);
  });

  it("uses the weakest token to distinguish message quality, with phrases breaking ties", () => {
    const tokens = queryTokens("auth tokens");
    const rank = (text: string) => textMatch(text, tokens)?.quality ?? 0;
    expect(rank("oauth tokens")).toBeLessThan(rank("authentication tokens"));
    expect(rank("authentication tokens")).toBeLessThan(rank("tokens for auth"));
    expect(rank("tokens for auth")).toBeLessThan(rank("auth tokens"));
    expect(rank("auth only")).toBe(0);
  });
});
