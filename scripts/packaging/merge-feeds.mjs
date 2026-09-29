#!/usr/bin/env node
// Gathers the update feeds the build jobs wrote into the set a release
// publishes. Each Mac architecture builds on its own runner and writes a
// latest-mac.yml for itself alone; they are merged into the one electron-builder
// writes when it builds both, which is what installed Macs read.
//
//   node scripts/packaging/merge-feeds.mjs <folder of build artifacts> <out folder>
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isMain, main } from "./release.mjs";

export const MAC_FEED = "latest-mac.yml";
export const MAC_ARCHES = ["x64", "arm64"];
// electron-builder's Arch enum, which orders the entries of a combined build.
const ARCH_ORDER = { x64: 1, arm64: 3 };

/** `Tau-1.2.3-arm64.dmg` and `Tau-1.2.3-arm64-mac.zip` are arm64; the unmarked ones x64. */
export function macArch(url) {
  return /-arm64(?:-mac)?\.(?:dmg|zip)$/u.test(url) ? "arm64" : "x64";
}

const unquote = (raw) => raw.replace(/^(['"])(.*)\1$/u, "$2");

/**
 * The feed as electron-builder writes it: top-level scalars and one `files`
 * list of flat entries. Values stay as written, quotes included; anything
 * else is refused rather than guessed at.
 */
export function parseFeed(text) {
  const top = [];
  const files = [];
  let inFiles = false;
  let entry;
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (line.trim() === "") continue;
    const scalar = /^([A-Za-z]\w*):(?: (.*))?$/u.exec(line);
    if (scalar) {
      inFiles = scalar[1] === "files" && scalar[2] === undefined;
      entry = undefined;
      if (!inFiles) {
        if (scalar[2] === undefined) throw new Error(`line ${index + 1}: ${scalar[1]} has no value`);
        top.push([scalar[1], scalar[2]]);
      } else top.push(["files", undefined]);
      continue;
    }
    const item = /^ {2}- (\w+): (.*)$/u.exec(line);
    const field = /^ {4}(\w+): (.*)$/u.exec(line);
    if (inFiles && item) {
      entry = [[item[1], item[2]]];
      files.push(entry);
    } else if (inFiles && entry && field) {
      entry.push([field[1], field[2]]);
    } else {
      throw new Error(`line ${index + 1} is not a shape an update feed has: ${JSON.stringify(line)}`);
    }
  }
  return { top, files };
}

export function serializeFeed({ top, files }) {
  const lines = [];
  for (const [key, raw] of top) {
    if (key !== "files") {
      lines.push(`${key}: ${raw}`);
      continue;
    }
    lines.push("files:");
    for (const entry of files) entry.forEach(([name, value], index) => lines.push(`${index === 0 ? "  - " : "    "}${name}: ${value}`));
  }
  return `${lines.join("\n")}\n`;
}

const get = (pairs, key) => pairs.find(([name]) => name === key)?.[1];

/**
 * One latest-mac.yml from the per-architecture ones: every file, zips first
 * and x64 before arm64 as electron-builder orders them, with `path` and
 * `sha512` naming the first (older updaters read only those).
 */
export function mergeMacFeeds(texts) {
  const feeds = texts.map(parseFeed);
  if (feeds.length === 0) throw new Error(`No ${MAC_FEED} to merge.`);
  const versions = new Set(feeds.map((feed) => unquote(get(feed.top, "version") ?? "")));
  if (versions.size !== 1) throw new Error(`The Mac feeds name different versions: ${[...versions].join(", ")}.`);
  const entries = feeds.flatMap((feed) => feed.files);
  const urls = entries.map((entry) => unquote(get(entry, "url") ?? ""));
  const repeated = urls.filter((url, index) => urls.indexOf(url) !== index);
  if (repeated.length) throw new Error(`Two Mac feeds name ${repeated.join(", ")}.`);
  for (const arch of MAC_ARCHES) {
    for (const ext of ["zip", "dmg"]) {
      if (!urls.some((url) => url.endsWith(`.${ext}`) && macArch(url) === arch)) throw new Error(`The Mac feeds name no ${arch} .${ext}.`);
    }
  }
  const rank = (entry) => {
    const url = unquote(get(entry, "url"));
    return (url.endsWith(".zip") ? 0 : 100) + ARCH_ORDER[macArch(url)];
  };
  const files = entries.map((entry, index) => ({ entry, index })).sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index).map(({ entry }) => entry);
  const dates = feeds.map((feed) => get(feed.top, "releaseDate")).filter(Boolean);
  const latestDate = dates.sort((a, b) => unquote(a).localeCompare(unquote(b))).at(-1);
  const top = feeds[0].top.map(([key, raw]) => {
    if (key === "path") return [key, get(files[0], "url")];
    if (key === "sha512") return [key, get(files[0], "sha512")];
    if (key === "releaseDate" && latestDate) return [key, latestDate];
    return [key, raw];
  });
  return serializeFeed({ top, files });
}

function feedsUnder(folder) {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /^latest.*\.yml$/u.test(entry.name))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .sort();
}

/**
 * Writes one of each feed found under `from` into `to`: the Mac ones merged,
 * any other copied, provided every copy of it is the same file.
 */
export function collectFeeds(from, to) {
  const byName = new Map();
  for (const path of feedsUnder(from)) byName.set(basename(path), [...(byName.get(basename(path)) ?? []), path]);
  mkdirSync(to, { recursive: true });
  for (const [name, paths] of byName) {
    if (name === MAC_FEED) {
      writeFileSync(join(to, name), mergeMacFeeds(paths.map((path) => readFileSync(path, "utf8"))));
      continue;
    }
    const texts = new Set(paths.map((path) => readFileSync(path, "utf8")));
    if (texts.size > 1) throw new Error(`The builds wrote different copies of ${name}: ${paths.join(", ")}.`);
    copyFileSync(paths[0], join(to, name));
  }
  return [...byName.keys()].sort();
}

if (isMain(import.meta.url)) {
  main(() => {
    const [from, to] = process.argv.slice(2);
    if (!from || !to) throw new Error("usage: merge-feeds.mjs <folder of build artifacts> <out folder>");
    console.log(`Wrote ${collectFeeds(from, to).join(", ")} to ${to}.`);
  });
}
