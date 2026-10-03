import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const ENTRIES = ["renderer/main.tsx", "web/main.tsx"].map((path) => join(SRC, path));
const SURFACES = join(SRC, "renderer/deferred-surfaces.ts");

// Static imports and re-exports that carry values; `import type` and `import()` load nothing at start-up.
const STATIC = /^(?:import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gmu;

function resolveModule(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = join(dirname(from), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]
    .find((path) => /\.tsx?$/u.test(path) && existsSync(path));
}

/** Every source module the entries reach through static imports, with the chain that reaches it. */
function startupGraph(): Map<string, string[]> {
  const reached = new Map<string, string[]>(ENTRIES.map((entry) => [entry, [entry]]));
  const queue = [...ENTRIES];
  while (queue.length > 0) {
    const module = queue.shift()!;
    for (const [, specifier] of readFileSync(module, "utf8").matchAll(STATIC)) {
      const target = resolveModule(module, specifier);
      if (!target || reached.has(target)) continue;
      reached.set(target, [...reached.get(module)!, target]);
      queue.push(target);
    }
  }
  return reached;
}

const deferredModules = [...readFileSync(SURFACES, "utf8").matchAll(/import\("(\.[^"]+)"\)/gu)]
  .map(([, specifier]) => resolveModule(SURFACES, specifier!)!);

// The initial script is budgeted (scripts/performance-budgets.json); these
// modules left it for chunks of their own (docs/PERFORMANCE.md).
describe("deferred surfaces", () => {
  it("names modules that exist", () => {
    expect(deferredModules.length).toBeGreaterThan(0);
    expect(deferredModules.every(Boolean)).toBe(true);
  });

  it("stay out of the start-up graph", () => {
    const graph = startupGraph();
    expect(graph.has(SURFACES)).toBe(true);
    const leaks = deferredModules
      .filter((module) => graph.has(module))
      .map((module) => graph.get(module)!.map((path) => relative(SRC, path)).join(" → "));
    expect(leaks).toEqual([]);
  });

  it("loads version update controls only when they are needed", () => {
    const controls = join(SRC, "renderer/host-version-update-controls.tsx");
    expect(existsSync(controls)).toBe(true);
    expect(startupGraph().has(controls)).toBe(false);
  });

  it("leave the kit API to the kits", () => {
    // `loadTauApi` imports it before the first bundle request.
    const api = startupGraph().get(join(SRC, "renderer/extension-api.ts"));
    expect(api?.map((path) => relative(SRC, path)).join(" → ")).toBeUndefined();
  });
});
