import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import clone from "./structured-clone";

const require = createRequire(import.meta.url);
const packageDir = (name: string) => dirname(require.resolve(name));

describe("structured-clone stand-in", () => {
  it("deep-copies like the package", () => {
    const value = { properties: { className: ["a"], dataFootnotes: true }, children: [{ value: "x" }] };
    const copy = clone(value);

    expect(copy).toEqual(value);
    expect(copy.properties).not.toBe(value.properties);
  });

  // The alias is only equivalent while every caller passes one argument and imports the default.
  it("matches every call in mdast-util-to-hast", () => {
    const lib = join(packageDir("mdast-util-to-hast"), "lib");
    const files = readdirSync(lib, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".js"));
    const sources = files.map((file) => readFileSync(join(lib, file), "utf8")).filter((source) => source.includes("@ungap/structured-clone"));

    const calls = sources.flatMap((source) => [...source.matchAll(/structuredClone\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gu)].map((call) => call[1]));
    expect(calls.length).toBeGreaterThan(0);
    for (const source of sources) expect(source).toMatch(/^import structuredClone from '@ungap\/structured-clone'$/mu);
    for (const argument of calls) expect(argument).not.toContain(",");
  });
});
