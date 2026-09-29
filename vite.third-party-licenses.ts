import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/**
 * The packages an installed Tau carries, the way a licence checker walks them:
 * every dependency of `package.json` and every devDependency a bundle takes,
 * with their own dependencies, resolved as Node resolves them. Sorted by name.
 */
export function collectThirdPartyLicenses(root: string): ThirdPartyLicense[] {
  const manifest = readPackage(root) ?? {};
  const found = new Map<string, ThirdPartyLicense>();
  const visited = new Set<string>();
  const visit = (name: string, from: string) => {
    const directory = resolvePackage(name, from);
    if (!directory || visited.has(directory)) return;
    visited.add(directory);
    const pkg = readPackage(directory);
    if (!pkg?.name || !pkg.version) return;
    const key = `${pkg.name}@${pkg.version}`;
    if (!found.has(key)) {
      const repository = repositoryOf(pkg);
      const text = noticeOf(directory);
      found.set(key, { name: pkg.name, version: pkg.version, license: licenseOf(pkg), ...(repository ? { repository } : {}), ...(text ? { text } : {}) });
    }
    if (WITHOUT_DEPENDENCIES.has(pkg.name)) return;
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dependency, directory);
  };
  for (const name of Object.keys(manifest.dependencies ?? {})) visit(name, root);
  for (const name of Object.keys(manifest.devDependencies ?? {})) if (!BUILD_ONLY_DEV_DEPENDENCIES.has(name)) visit(name, root);
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

/** Files Tau carries that come from no npm package: the interface font. */
export const BUNDLED_FILES: ReadonlyArray<Omit<ThirdPartyLicense, "text"> & { notice: string }> = [
  { name: "Figtree", version: "Google Fonts v9, via @fontsource-variable/figtree 5.3.0", license: "OFL-1.1", repository: "https://github.com/erikdkennedy/figtree", notice: "src/renderer/assets/fonts/figtree/OFL.txt" },
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
export function thirdPartyLicenses(root: string = process.cwd()): Plugin {
  let cached: string | undefined;
  const json = () => (cached ??= JSON.stringify(packLicenses([...collectThirdPartyLicenses(root), ...bundledFileLicenses(root)])));
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
