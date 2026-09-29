import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signFeed, verifyFeed, rawPublicKey } from "../packaging/release-signing.mjs";
import { buildModelCatalog, canonicalCatalog } from "./build-model-catalog.mjs";

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("model catalog build", () => {
  it("writes the models in one order, so a signature covers the same bytes every build", () => {
    const text = JSON.stringify({ revision: 2, schema: 1, models: [{ provider: "openai", id: "b", name: "B" }, { provider: "anthropic", id: "a", name: "A" }] });
    const canonical = canonicalCatalog(text);
    expect(JSON.parse(canonical).models.map((model) => model.provider)).toEqual(["anthropic", "openai"]);
    expect(canonicalCatalog(canonical)).toBe(canonical);
    expect(() => canonicalCatalog(JSON.stringify({ schema: 1, revision: 0, models: [] }))).toThrow("raise it");
  });

  it("builds the repository's catalog, which a throwaway key signs the way the workflow's key does", () => {
    const directory = mkdtempSync(join(tmpdir(), "tau-model-catalog-build-"));
    directories.push(directory);
    const { target, revision } = buildModelCatalog(undefined, join(directory, "catalog", "models.json"));
    expect(revision).toBeGreaterThan(0);
    const { privateKey } = generateKeyPairSync("ed25519");
    const bytes = readFileSync(target);
    const signature = signFeed(bytes, [privateKey], target);
    writeFileSync(`${target}.sig`, signature);
    expect(verifyFeed(bytes, readFileSync(`${target}.sig`, "utf8"), [rawPublicKey(privateKey)])).toBe(true);
  });
});
