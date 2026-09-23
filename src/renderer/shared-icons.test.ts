import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as lucide from "lucide-react";
import { describe, expect, it } from "vitest";
import { sharedIconModule } from "./shared-icons";

// The ES entry the renderer bundles; Node resolves the bare name to the CommonJS one.
const ESM_ENTRY = pathToFileURL(join(dirname(createRequire(import.meta.url).resolve("lucide-react")), "..", "esm", "lucide-react.mjs")).href;

describe("sharedIconModule", () => {
  it("has exactly the names of lucide-react's ES module namespace, in its order", async () => {
    const namespace = await import(/* @vite-ignore */ ESM_ENTRY) as Record<string, unknown>;
    expect(Object.keys(sharedIconModule())).toEqual(Object.keys(namespace));
  });

  it("binds each name to lucide-react's own export", () => {
    const shared = sharedIconModule();
    const exports = lucide as unknown as Record<string, unknown>;
    for (const name of Object.keys(shared)) expect(shared[name], name).toBe(exports[name]);
  });
});
