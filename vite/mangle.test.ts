import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "vite";
import { mangleChunk, mangleForGzip } from "./mangle";

const CHUNK = [
  "/*! @license widget v1 | MIT */",
  'import{a as importedHelper}from"./helper.js";',
  "function makeCounter(initialValue){let currentValue=initialValue;return()=>currentValue+=1+2}",
  'const label="currentValue";',
  "export{makeCounter as m,label as l,importedHelper as h};",
].join("");

describe("mangleChunk", () => {
  it("renames local names and nothing else", async () => {
    const { code } = await mangleChunk(CHUNK, false);

    expect(code).not.toMatch(/initialValue|makeCounter|importedHelper/u);
    expect(code).toContain('"currentValue"');
    expect(code).toContain("1+2");
    expect(code).toMatch(/from"\.\/helper\.js"/u);
    expect(code).toMatch(/export\{.* as m,.* as l,.* as h\}/u);
    expect(code.length).toBeLessThan(CHUNK.length);
  });

  it("keeps legal comments", async () => {
    expect((await mangleChunk(CHUNK, false)).code).toContain("/*! @license widget v1 | MIT */");
  });

  it("returns a source map when the build writes one", async () => {
    expect((await mangleChunk(CHUNK, false)).map).toBeNull();
    expect(JSON.parse((await mangleChunk(CHUNK, true)).map ?? "{}").mappings).toBeTruthy();
  });
});

describe("mangleForGzip", () => {
  const plugin = (minify: ResolvedConfig["build"]["minify"]) => {
    const instance = mangleForGzip();
    (instance.configResolved as (config: unknown) => void)({ build: { minify } });
    return instance.renderChunk as { order: string; handler: (...args: unknown[]) => Promise<{ code: string } | null> };
  };

  it("runs after Vite's minifier", () => {
    expect(plugin("esbuild").order).toBe("post");
  });

  it("leaves unminified builds alone", async () => {
    expect(await plugin(false).handler(CHUNK, {}, {})).toBeNull();
    expect((await plugin("esbuild").handler(CHUNK, {}, {}))?.code).not.toContain("makeCounter");
  });
});
