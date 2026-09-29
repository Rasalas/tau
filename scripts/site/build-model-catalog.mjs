#!/usr/bin/env node
// Tau's model catalog for the website: catalog/models.json, written in one
// canonical form to site/catalog/models.json (gitignored). The Pages workflow
// signs the result with the release key (release-signing.mjs sign) and
// publishes both; installed hosts refuse it without that signature.
// src/main/model-catalog.test.ts parses the source with the host's own parser.
//
//   node scripts/site/build-model-catalog.mjs [source] [target]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const SOURCE = join(ROOT, "catalog", "models.json");
export const TARGET = join(ROOT, "site", "catalog", "models.json");

/** The catalog as the host reads it: the known top-level fields in order, the models sorted by provider and id. */
export function canonicalCatalog(text) {
  const catalog = JSON.parse(text);
  if (catalog?.schema !== 1) throw new Error("catalog/models.json: schema must be 1.");
  if (!Number.isInteger(catalog.revision) || catalog.revision < 1) throw new Error("catalog/models.json: revision must be a positive whole number; raise it with every change.");
  if (!Array.isArray(catalog.models)) throw new Error("catalog/models.json: models must be a list.");
  const models = [...catalog.models].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
  return `${JSON.stringify({ schema: 1, revision: catalog.revision, models }, null, 2)}\n`;
}

export function buildModelCatalog(source = SOURCE, target = TARGET) {
  const text = canonicalCatalog(readFileSync(source, "utf8"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  return { target, revision: JSON.parse(text).revision };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { target, revision } = buildModelCatalog(process.argv[2], process.argv[3]);
  console.log(`[site] model catalog revision ${revision} in ${target}`);
}
