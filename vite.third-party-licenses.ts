import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import type { Plugin } from "vite";
import { LICENSES_FILE, packLicenses, type ThirdPartyLicense } from "./src/shared/third-party-licenses";

/** devDependencies that only build or test Tau; every other one ends up in a bundle. */
export const BUILD_ONLY_DEV_DEPENDENCIES = new Set([
  "@testing-library/react", "@types/ws", "concurrently", "electron-builder", "jsdom", "oxlint", "vitest", "wait-on",
  // The Servers kit's fake SSH and FTP servers, for tests and test instances only.
  "ftp-srv", "ssh2",
]);

/** Shipped, but not their dependencies: Electron's are its installer's. */
export const WITHOUT_DEPENDENCIES = new Set(["electron"]);

const NOTICE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/iu;

interface PackageJson {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
  repository?: unknown;
  author?: unknown;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackage(directory: string): PackageJson | undefined {
  try { return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as PackageJson; } catch { return undefined; }
}

/** Node's lookup: the nearest `node_modules/<name>` from `from` up to the filesystem root. */
function resolvePackage(name: string, from: string): string | undefined {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(directory) === directory) return undefined;
  }
}

function licenseOf(pkg: PackageJson): string {
  const named = (value: unknown) => typeof value === "string" ? value : (value as { type?: unknown } | null)?.type;
  const single = named(pkg.license);
  if (typeof single === "string" && single) return single;
  if (Array.isArray(pkg.licenses)) {
    const all = pkg.licenses.map(named).filter((value): value is string => typeof value === "string" && value.length > 0);
    if (all.length > 0) return all.join(" OR ");
  }
  return "UNKNOWN";
}

function repositoryOf(pkg: PackageJson): string | undefined {
  const raw = typeof pkg.repository === "string" ? pkg.repository : (pkg.repository as { url?: unknown } | null)?.url;
  if (typeof raw !== "string" || !raw) return undefined;
  const url = raw.replace(/^git\+/u, "").replace(/\.git$/u, "").replace(/^git:\/\//u, "https://").replace(/^ssh:\/\/git@/u, "https://");
  if (/^https?:\/\//u.test(url)) return url;
  // `owner/repo` and `github:owner/repo` are GitHub shorthands.
  const shorthand = /^(?:github:)?([\w.-]+\/[\w.-]+)$/u.exec(url);
  return shorthand ? `https://github.com/${shorthand[1]}` : undefined;
}

function noticeOf(directory: string): string | undefined {
  let files: string[];
  try { files = readdirSync(directory); } catch { return undefined; }
  const file = files.filter((name) => NOTICE_FILE.test(name)).sort()[0];
  if (!file) return undefined;
  try { return readFileSync(join(directory, file), "utf8").trim() || undefined; } catch { return undefined; }
}

function authorOf(pkg: PackageJson): string | undefined {
  const raw = typeof pkg.author === "string" ? pkg.author : (pkg.author as { name?: unknown } | null)?.name;
  // "Name <mail> (url)" keeps the name.
  return typeof raw === "string" ? raw.replace(/\s*[<(].*$/u, "").trim() || undefined : undefined;
}

type Found = ThirdPartyLicense & { author?: string };

/** Walks from (package, directory it is imported from) pairs as Node resolves them. */
function walkPackages(starts: Iterable<readonly [string, string]>, skip: (name: string) => boolean = () => false): Found[] {
  const found = new Map<string, Found>();
  const visited = new Set<string>();
  const visit = (name: string, from: string) => {
    if (skip(name)) return;
    const directory = resolvePackage(name, from);
    if (!directory || visited.has(directory)) return;
    visited.add(directory);
    const pkg = readPackage(directory);
    if (!pkg?.name || !pkg.version || skip(pkg.name)) return;
    const key = `${pkg.name}@${pkg.version}`;
    if (!found.has(key)) {
      const repository = repositoryOf(pkg);
      const text = noticeOf(directory);
      const author = authorOf(pkg);
      found.set(key, { name: pkg.name, version: pkg.version, license: licenseOf(pkg), ...(repository ? { repository } : {}), ...(text ? { text } : {}), ...(author ? { author } : {}) });
    }
    if (WITHOUT_DEPENDENCIES.has(pkg.name)) return;
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dependency, directory);
  };
  for (const [name, from] of starts) visit(name, from);
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

/** Licence texts for sources that ship none, one file per GitHub repository: `<owner>__<repo>.txt`, lower case. */
export const SUPPLIED_LICENSES_DIR = "scripts/open-source/licenses";

export function suppliedLicenseText(root: string, repository: string | undefined): string | undefined {
  const match = repository ? /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/u.exec(repository) : null;
  if (!match) return undefined;
  try { return readFileSync(join(root, SUPPLIED_LICENSES_DIR, `${match[1]}__${match[2]}.txt`.toLowerCase()), "utf8").trim() || undefined; } catch { return undefined; }
}

/** The MIT licence's own words, for a package that names it but ships no copy. */
export function mitLicenseText(holder: string): string {
  return `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
}

/** Where a text for an entry without one comes from; see `missingText`. */
export type TextSource = "repository" | "supplied" | "template";

/**
 * A text for a package that ships none: a package from the same repository
 * carries one (a platform binary's main package), a supplied file, or for MIT
 * the licence's words with the package's author as holder.
 */
export function missingText(root: string, entry: { name: string; license: string; repository?: string | undefined; author?: string | undefined }, byRepository: ReadonlyMap<string, string>): { text: string; source: TextSource } | undefined {
  const sibling = entry.repository ? byRepository.get(entry.repository) : undefined;
  if (sibling) return { text: sibling, source: "repository" };
  const supplied = suppliedLicenseText(root, entry.repository);
  if (supplied) return { text: supplied, source: "supplied" };
  if (entry.license === "MIT") return { text: mitLicenseText(entry.author ?? `the ${entry.name} authors`), source: "template" };
  return undefined;
}

function withTexts(root: string, found: readonly Found[]): ThirdPartyLicense[] {
  const byRepository = new Map<string, string>();
  for (const entry of found) if (entry.repository && entry.text && !byRepository.has(entry.repository)) byRepository.set(entry.repository, entry.text);
  return found.map((entry) => {
    const { author: _author, ...license } = entry;
    const filled = license.text ? undefined : missingText(root, entry, byRepository);
    return filled ? { ...license, text: filled.text } : license;
  });
}

/**
 * The packages an installed Tau carries, the way a licence checker walks them:
 * every dependency of `package.json` and every devDependency a bundle takes,
 * with their own dependencies, resolved as Node resolves them. Sorted by name.
 */
export function collectThirdPartyLicenses(root: string): ThirdPartyLicense[] {
  const manifest = readPackage(root) ?? {};
  const starts = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}).filter((name) => !BUILD_ONLY_DEV_DEPENDENCIES.has(name)),
  ].map((name) => [name, root] as const);
  return withTexts(root, walkPackages(starts));
}

// Import scanning: enough of the syntax to find the packages a bundle can reach, never the type-only ones.
const STATIC_IMPORT = /(?:^|[\n;])\s*(?:import|export)\s+(type\s+)?([^'";]*?)\s*from\s*["']([^"']+)["']/gu;
const SIDE_EFFECT_IMPORT = /(?:^|[\n;])\s*import\s*["']([^"']+)["']/gu;
const CALL_IMPORT = /\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/gu;
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/u;
const BUILTINS = new Set(builtinModules);

export const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"'\\])\/\/.*$/gmu, "$1");
const onlyTypes = (clause: string) => /^\{\s*(?:type\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*)+\}$/u.test(clause.trim());
export const packageName = (specifier: string) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;

function specifiersOf(source: string): string[] {
  const code = withoutComments(source);
  const found: string[] = [];
  for (const [, type, clause, specifier] of code.matchAll(STATIC_IMPORT)) if (!type && !onlyTypes(clause!)) found.push(specifier!);
  for (const [, specifier] of code.matchAll(SIDE_EFFECT_IMPORT)) found.push(specifier!);
  for (const [, specifier] of code.matchAll(CALL_IMPORT)) found.push(specifier!);
  return found;
}

function resolveSource(specifier: string, from: string): string | undefined {
  const base = resolve(dirname(from), specifier.replace(/\?.*$/u, ""));
  const candidates = [base, ...[".ts", ".tsx", ".mts", ".js", ".mjs"].map((extension) => base + extension),
    base.replace(/\.[cm]?js$/u, ".ts"), base.replace(/\.[cm]?js$/u, ".tsx"), join(base, "index.ts"), join(base, "index.tsx")];
  return candidates.find((candidate) => CODE_FILE.test(candidate) && existsSync(candidate) && statSync(candidate).isFile());
}

/** Bare packages reachable from `entries` through relative imports, as (name, importing directory) pairs. */
export function reachablePackages(entries: readonly string[], root: string): { packages: Array<[string, string]>; files: number; unresolved: string[] } {
  const seen = new Set<string>();
  const packages = new Map<string, [string, string]>();
  const unresolved: string[] = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith(".")) {
        const target = resolveSource(specifier, file);
        if (target) queue.push(target);
        else if (/\.(?:[cm]?[jt]sx?)$|^[^.]*$/u.test(specifier.replace(/\?.*$/u, "").split("/").pop() ?? "")) unresolved.push(`${relative(root, file)} → ${specifier}`);
        continue;
      }
      const name = packageName(specifier);
      if (specifier.startsWith("node:") || BUILTINS.has(name) || name === "tau" || /^(?:virtual|data|https?):/u.test(specifier)) continue;
      const key = `${name}\0${dirname(file)}`;
      if (!packages.has(key)) packages.set(key, [name, dirname(file)]);
    }
  }
  return { packages: [...packages.values()], files: seen.size, unresolved };
}

/** The mobile app's JavaScript: what its entry reaches (core's compact client included) and its own dependencies. */
export function mobileStarts(root: string): { starts: Array<readonly [string, string]>; files: number; unresolved: string[] } {
  const mobile = join(root, "mobile");
  const graph = reachablePackages([join(mobile, "src", "main.tsx")], root);
  const own = Object.entries(readPackage(mobile)?.dependencies ?? {})
    .filter(([, range]) => !String(range).startsWith("file:"))
    .map(([name]) => [name, mobile] as const);
  return { starts: [...graph.packages, ...own], files: graph.files, unresolved: graph.unresolved };
}

/** What the iOS and Android app carries of npm, which its About lists instead of the desktop app's. */
export function collectMobileLicenses(root: string): ThirdPartyLicense[] {
  const firstParty = new Set([join(root, "mobile"), join(root, "mobile", "plugins", "tau-native")].map((directory) => readPackage(directory)?.name).filter(Boolean));
  return withTexts(root, walkPackages(mobileStarts(root).starts, (name) => firstParty.has(name)));
}

/** What Tau carries that comes from no npm package: the interface font, and source it adapted. */
export const BUNDLED_FILES: ReadonlyArray<Omit<ThirdPartyLicense, "text"> & { notice: string }> = [
  { name: "Figtree", version: "Google Fonts v9, via @fontsource-variable/figtree 5.3.0", license: "OFL-1.1", repository: "https://github.com/erikdkennedy/figtree", notice: "src/renderer/assets/fonts/figtree/OFL.txt" },
  { name: "T3 Code", version: "portions adapted in kits/review/pull-request-list-logic.ts", license: "MIT", repository: "https://github.com/pingdotgg/t3code", notice: "scripts/open-source/licenses/pingdotgg__t3code.txt" },
];

/** The bundled files' entries, each with its licence text; a file that is gone is left out. */
export function bundledFileLicenses(root: string): ThirdPartyLicense[] {
  return BUNDLED_FILES.flatMap(({ notice, ...entry }) => {
    try { return [{ ...entry, text: readFileSync(join(root, notice), "utf8").trim() }]; } catch { return []; }
  });
}

/**
 * Writes `third-party-licenses.json` beside the page, which Settings → About
 * reads when it opens. JSON rather than a module: it stays out of every
 * JavaScript budget and costs nothing until someone looks.
 */
export function thirdPartyLicenses(root: string = process.cwd(), options: { app?: "desktop" | "mobile" } = {}): Plugin {
  let cached: string | undefined;
  const collect = options.app === "mobile" ? collectMobileLicenses : collectThirdPartyLicenses;
  const json = () => (cached ??= JSON.stringify(packLicenses([...collect(root), ...bundledFileLicenses(root)])));
  return {
    name: "tau-third-party-licenses",
    configureServer(server) {
      server.middlewares.use(`/${LICENSES_FILE}`, (_request, response) => {
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(json());
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: LICENSES_FILE, source: json() });
    },
  };
}
