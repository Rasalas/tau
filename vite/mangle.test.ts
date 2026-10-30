import { describe, expect, it } from "vitest";
import type { ResolvedConfig } from "vite";
import { mangleChunk, mangleForGzip, terserPool } from "./mangle";

const CHUNK = [
  "/*! @license widget v1 | MIT */",
  'import{a as importedHelper}from"./helper.js";',
  "function makeCounter(initialValue){let currentValue=initialValue;return()=>currentValue+=1+2}",
  'const label="currentValue";',
  "export{makeCounter as m,label as l,importedHelper as h};",
].join("");

describe("mangleChunk", () => {
  it("renames local names and folds what it can, keeping strings", async () => {
    const { code } = await mangleChunk(CHUNK, false);

    expect(code).not.toMatch(/initialValue|makeCounter|importedHelper/u);
    expect(code).toContain('"currentValue"');
    expect(code).not.toContain("1+2");
    expect(code).toMatch(/from"\.\/helper\.js"/u);
    expect(code).toMatch(/export\{.* as m,.* as l,.* as h\}/u);
    expect(code.length).toBeLessThan(CHUNK.length);
  });

  it("preserves branch results and side-effect order through repeated compression", async () => {
    const source = "function run(value){let hits=0;function next(){hits++;return value+hits}if(value){capture(next(),next(),hits)}else capture(next(),hits)}run(input)";
    const { code } = await mangleChunk(source, false);
    for (const input of [0, 2, -2]) {
      const original: number[][] = [];
      const compressed: number[][] = [];
      new Function("input", "capture", source)(input, (...values: number[]) => original.push(values));
      new Function("input", "capture", code)(input, (...values: number[]) => compressed.push(values));
      expect(compressed).toEqual(original);
    }
  });

  it("keeps legal comments", async () => {
    expect((await mangleChunk(CHUNK, false)).code).toContain("/*! @license widget v1 | MIT */");
  });

  it("returns a source map when the build writes one", async () => {
    expect((await mangleChunk(CHUNK, false)).map).toBeNull();
    expect(JSON.parse((await mangleChunk(CHUNK, true)).map ?? "{}").mappings).toBeTruthy();
  });
});

describe("terserPool", () => {
  it("returns what mangleChunk returns, for chunks sent at once", async () => {
    const pool = terserPool(2);
    try {
      const chunks = [CHUNK, CHUNK.replace("widget", "gadget"), CHUNK.replace("currentValue", "otherValue")];
      const results = await Promise.all(chunks.flatMap((chunk) => [pool.mangle(chunk, false), pool.mangle(chunk, true)]));
      expect(results).toEqual(await Promise.all(chunks.flatMap((chunk) => [mangleChunk(chunk, false), mangleChunk(chunk, true)])));
    } finally {
      await pool.close();
    }
  });

  it("rejects a chunk terser cannot parse and keeps working", async () => {
    const pool = terserPool(1);
    try {
      await expect(pool.mangle("export {", false)).rejects.toThrow();
      expect(await pool.mangle(CHUNK, false)).toEqual(await mangleChunk(CHUNK, false));
    } finally {
      await pool.close();
    }
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
