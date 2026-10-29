import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  it("keeps optional transcript controls out of the first paint", () => {
    const graph = startupGraph();
    for (const name of ["Message", "UserMessage", "TranscriptViewport", "VirtualTranscript"]) {
      expect(graph.has(join(SRC, `renderer/components/${name}.tsx`))).toBe(true);
    }
    for (const name of ["MessageActions", "TranscriptTurnNavigation"]) {
      const module = join(SRC, `renderer/components/${name}.tsx`);
      expect(existsSync(module)).toBe(true);
      expect(graph.get(module)?.map((path) => relative(SRC, path))).toBeUndefined();
    }
    expect(graph.has(join(SRC, "renderer/components/transcript-turn-navigation-layout.ts"))).toBe(false);
  });

  it("tree shakes unrequested Markdown exports through Vite's preload wrapper", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-deferred-exports-"));
    try {
      const source = readFileSync(join(SRC, "renderer/components/LazyMarkdown.tsx"), "utf8");
      const loader = source.match(/const loadMarkdown = deferredModule\((.+)\);/u)?.[1];
      expect(loader).toBeTruthy();
      await writeFile(join(root, "Markdown.js"), 'export const Markdown = "Markdown"; export const unused = "unused-markdown-export";');
      await writeFile(join(root, "main.js"), `globalThis.loadMarkdown = ${loader};`);
      const { build } = await import("vite");
      const built = await build({
        configFile: false,
        root,
        logLevel: "silent",
        build: { write: false, minify: false, rollupOptions: { input: join(root, "main.js") } },
      });
      const outputs = Array.isArray(built) ? built : [built];
      const code = outputs.flatMap((output) => "output" in output ? output.output : [])
        .filter((chunk) => chunk.type === "chunk").map((chunk) => chunk.code).join("\n");
      expect(code).toContain("Markdown");
      expect(code).not.toContain("unused-markdown-export");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leave the kit API to the kits", () => {
    // `loadTauApi` imports it before the first bundle request.
    const api = startupGraph().get(join(SRC, "renderer/extension-api.ts"));
    expect(api?.map((path) => relative(SRC, path)).join(" → ")).toBeUndefined();
  });
});
