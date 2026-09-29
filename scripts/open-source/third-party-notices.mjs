#!/usr/bin/env node
// Writes the third-party notices for what Tau ships: the desktop app (kits included) and the mobile app.
// Usage: node scripts/open-source/third-party-notices.mjs [--out <file>] [--check]
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { builtinModules, registerHooks } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MOBILE = join(ROOT, "mobile");
const KITS = join(ROOT, "kits");
// release/ is electron-builder's output folder and gitignored.
const DEFAULT_OUT = join(ROOT, "release", "THIRD_PARTY_NOTICES.md");

// The in-app collector is TypeScript with extensionless imports: Node 22.18+ strips the types, this adds the `.ts`.
if (typeof registerHooks !== "function") throw new Error("Needs Node 22.18 or newer (module.registerHooks and type stripping).");
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); } catch (error) {
      if (!/^\.\.?\//u.test(specifier) || /\.[cm]?[jt]sx?$/u.test(specifier)) throw error;
      return next(`${specifier}.ts`, context);
    }
  },
});
const collector = await import(pathToFileURL(join(ROOT, "vite.third-party-licenses.ts")).href);

// Whole packages electron-builder.yml's `files` leaves out of the packaged app, e.g. "!node_modules/@scope/name-*/**".
const NOT_PACKAGED = [...readFileSync(join(ROOT, "electron-builder.yml"), "utf8").matchAll(/^\s*-\s*"!node_modules\/((?:@[^/"]+\/)?[^/"]+)\/\*\*"/gmu)]
  .map(([, glob]) => new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*")}$`, "u"));
// Same pattern as the collector, plus notice files some packages name differently.
const NOTICE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-]|$)|^third[-_]?party[-_]?notice/iu;

const PERMISSIVE = /^(?:MIT|MIT-0|ISC|BSD|0BSD|Apache-2\.0|Unlicense|CC0|BlueOak|Python-2\.0|Zlib|WTFPL|X11|Artistic-2\.0|OFL-1\.1)/iu;
const WEAK_COPYLEFT = /^(?:MPL|LGPL|EPL|CDDL|EUPL)/iu;
const STRONG_COPYLEFT = /^(?:GPL|AGPL|SSPL|OSL)/iu;
const ATTRIBUTION = /^CC-BY(?!-NC|-ND)/iu;
const RANK = ["permissive", "attribution", "weak copyleft", "strong copyleft", "custom or unknown"];

/** Reviewed non-permissive entries, by package name: what was decided and why. */
const REVIEWED = new Map([
  ["caniuse-lite", "CC-BY-4.0 data; this file gives the attribution"],
]);

/** Licences of the mobile app's native libraries, by Maven coordinate or Swift package URL. */
const NATIVE_TERMS = [
  [/^androidx\./u, "Apache-2.0", "https://developer.android.com/jetpack/androidx"],
  [/^org\.apache\.cordova:/u, "Apache-2.0", "https://github.com/apache/cordova-android", "carries the Apache Cordova NOTICE"],
  [/^com\.squareup\.okhttp3:/u, "Apache-2.0", "https://github.com/square/okhttp"],
  [/^com\.google\.firebase:/u, "Apache-2.0", "https://github.com/firebase/firebase-android-sdk", "pulls in Google Play services libraries under the Android SDK License"],
  [/^com\.google\.android\.gms:/u, "LicenseRef-Android-SDK-License", "https://developer.android.com/studio/terms", "proprietary Google library"],
  [/capacitor-swift-pm/u, "MIT AND Apache-2.0", "https://github.com/ionic-team/capacitor-swift-pm", "Capacitor is MIT; its Cordova part is Apache-2.0 with the Apache Cordova NOTICE"],
];

// Apache-2.0 §4(d): Cordova's sources point at this NOTICE (cordova-android, and Capacitor's CapacitorCordova on iOS).
const CORDOVA_NOTICE = "Apache Cordova\nCopyright 2012 The Apache Software Foundation\n\nThis product includes software developed at\nThe Apache Software Foundation (http://www.apache.org/).";

const newestEntry = (path) => { try { return readdirSync(join(ROOT, path)).sort().pop(); } catch { return undefined; } };
const bundleVersion = (plist) => { try { return /CFBundleShortVersionString<\/key>\s*<string>([^<]+)/u.exec(readFileSync(join(ROOT, plist), "utf8"))?.[1]; } catch { return undefined; } };

/** Programs vendored inside npm packages that bring no licence file of their own; listed when their package is installed. */
const VENDORED = [
  { name: "Cua Driver", version: bundleVersion("node_modules/@amaster.ai/pi-computer-use/bin/darwin-universal/CuaDriver.app/Contents/Info.plist"), license: "MIT", repository: "https://github.com/trycua/cua", within: "@amaster.ai/pi-computer-use (bin/)", path: "node_modules/@amaster.ai/pi-computer-use/bin" },
  { name: "ConPTY (conpty.dll, OpenConsole.exe)", version: newestEntry("node_modules/node-pty/third_party/conpty"), license: "MIT", repository: "https://github.com/microsoft/terminal", within: "node-pty (third_party/conpty, Windows)", path: "node_modules/node-pty/third_party/conpty" },
  { name: "GNU C Library, statically linked into apply-seccomp", version: undefined, license: "LGPL-2.1-or-later", repository: "https://sourceware.org/glibc/", within: "@anthropic-ai/sandbox-runtime (vendor/seccomp, Linux)", path: "node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp" },
].filter((entry) => existsSync(join(ROOT, entry.path))).map(({ path: _path, ...entry }) => ({ ...entry, version: entry.version ?? "unknown" }));

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; }
}

const readPackage = (directory) => readJson(join(directory, "package.json"));
const FIRST_PARTY = new Set([ROOT, KITS, MOBILE, join(MOBILE, "plugins", "tau-native")].map((directory) => readPackage(directory)?.name).filter(Boolean));

function resolvePackage(name, from) {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(directory) === directory) return undefined;
  }
}

function licenseOf(pkg) {
  const named = (value) => typeof value === "string" ? value : value?.type;
  const single = named(pkg.license);
  if (typeof single === "string" && single) return single;
  if (Array.isArray(pkg.licenses)) {
    const all = pkg.licenses.map(named).filter((value) => typeof value === "string" && value);
    if (all.length > 0) return all.join(" OR ");
  }
  return "UNKNOWN";
}

function repositoryOf(pkg) {
  const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (typeof raw !== "string" || !raw) return undefined;
  const url = raw.replace(/^git\+/u, "").replace(/\.git$/u, "").replace(/^git:\/\//u, "https://").replace(/^ssh:\/\/git@/u, "https://");
  if (/^https?:\/\//u.test(url)) return url;
  const shorthand = /^(?:github:)?([\w.-]+\/[\w.-]+)$/u.exec(url);
  return shorthand ? `https://github.com/${shorthand[1]}` : undefined;
}

/** Every licence and notice file at the package's top level, unlike the in-app list, which keeps the first. */
function noticeFiles(directory) {
  let names;
  try { names = readdirSync(directory); } catch { return []; }
  return names.filter((name) => NOTICE_FILE.test(name)).sort().flatMap((name) => {
    try {
      if (!statSync(join(directory, name)).isFile()) return [];
      const text = readFileSync(join(directory, name), "utf8").trim();
      return text ? [{ name, text }] : [];
    } catch { return []; }
  });
}

/** Mirrors `collectThirdPartyLicenses`, but starts from any (name, directory) pairs, as an import graph gives them. */
function walk(requests, entries, artifact) {
  const visited = new Set();
  const visit = (name, from) => {
    if (FIRST_PARTY.has(name)) return;
    const directory = resolvePackage(name, from);
    if (!directory || visited.has(directory)) return;
    visited.add(directory);
    const pkg = readPackage(directory);
    if (!pkg?.name || !pkg.version || FIRST_PARTY.has(pkg.name)) return;
    if (artifact !== "mobile" && NOT_PACKAGED.some((pattern) => pattern.test(pkg.name))) return;
    const key = `${pkg.name}@${pkg.version}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = { name: pkg.name, version: pkg.version, license: licenseOf(pkg), repository: repositoryOf(pkg), files: noticeFiles(directory), artifacts: new Set() };
      entries.set(key, entry);
    }
    entry.artifacts.add(artifact);
    if (collector.WITHOUT_DEPENDENCIES.has(pkg.name)) return;
    for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dependency, directory);
  };
  for (const [name, from] of requests) visit(name, from);
}

// Import scanning: enough of the syntax to find the packages a bundle can reach, never the type-only ones.
const STATIC_IMPORT = /(?:^|[\n;])\s*(?:import|export)\s+(type\s+)?([^'";]*?)\s*from\s*["']([^"']+)["']/gu;
const SIDE_EFFECT_IMPORT = /(?:^|[\n;])\s*import\s*["']([^"']+)["']/gu;
const CALL_IMPORT = /\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/gu;
const LOAD_DEPENDENCY = /\bloadDependency\(\s*(?:["']([^"']+)["']|([A-Z_]+)\s*\))/gu;
const STRING_CONSTANT = /\bconst\s+([A-Z_]+)\s*=\s*["']([^"']+)["']/gu;
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/u;
const BUILTINS = new Set(builtinModules);

const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"'\\])\/\/.*$/gmu, "$1");
const onlyTypes = (clause) => /^\{\s*(?:type\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*)+\}$/u.test(clause.trim());
const packageName = (specifier) => specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];

function specifiersOf(source) {
  const code = withoutComments(source);
  const found = [];
  for (const [, type, clause, specifier] of code.matchAll(STATIC_IMPORT)) if (!type && !onlyTypes(clause)) found.push(specifier);
  for (const [, specifier] of code.matchAll(SIDE_EFFECT_IMPORT)) found.push(specifier);
  for (const [, specifier] of code.matchAll(CALL_IMPORT)) found.push(specifier);
  return found;
}

function resolveSource(specifier, from) {
  const base = resolve(dirname(from), specifier.replace(/\?.*$/u, ""));
  const candidates = [base, ...[".ts", ".tsx", ".mts", ".js", ".mjs"].map((extension) => base + extension),
    base.replace(/\.[cm]?js$/u, ".ts"), base.replace(/\.[cm]?js$/u, ".tsx"), join(base, "index.ts"), join(base, "index.tsx")];
  return candidates.find((candidate) => CODE_FILE.test(candidate) && existsSync(candidate) && statSync(candidate).isFile());
}

/** Bare packages reachable from `entries` through relative imports, as (name, importing directory) pairs. */
function reachablePackages(entries) {
  const seen = new Set();
  const packages = new Map();
  const unresolved = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith(".")) {
        const target = resolveSource(specifier, file);
        if (target) queue.push(target);
        else if (/\.(?:[cm]?[jt]sx?)$|^[^.]*$/u.test(specifier.replace(/\?.*$/u, "").split("/").pop())) unresolved.push(`${relative(ROOT, file)} → ${specifier}`);
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

function kitSources(directory = KITS) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    // Test fixtures (fake SSH and FTP servers) never ship.
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "fixtures" ? [] : kitSources(path);
    return CODE_FILE.test(entry.name) && !/\.test\.[jt]sx?$|\.d\.ts$/u.test(entry.name) ? [path] : [];
  });
}

/** Packages kits load at run time through `services.loadDependency`, by literal or by a string constant. */
function loadedByKits(files) {
  const sources = files.map((file) => [file, withoutComments(readFileSync(file, "utf8"))]);
  const constants = new Map(sources.flatMap(([, code]) => [...code.matchAll(STRING_CONSTANT)].map(([, name, value]) => [name, value])));
  return sources.flatMap(([file, code]) => [...code.matchAll(LOAD_DEPENDENCY)]
    .map(([, literal, constant]) => literal ?? constants.get(constant))
    .filter(Boolean)
    .map((name) => [packageName(name), dirname(file)]));
}

// Mobile native side: Gradle `implementation` lines and the Swift packages Capacitor pins.
function gradleVariables(file) {
  const variables = {};
  if (!existsSync(file)) return variables;
  for (const [, name, value] of readFileSync(file, "utf8").matchAll(/^\s*(\w+)\s*=\s*(?:[^\n]*?:\s*)?['"]([^'"$]+)['"]\s*$/gmu)) variables[name] = value;
  return variables;
}

function nativeLibraries() {
  const android = join(MOBILE, "android");
  const rootVariables = gradleVariables(join(android, "variables.gradle"));
  const settings = existsSync(join(android, "capacitor.settings.gradle")) ? readFileSync(join(android, "capacitor.settings.gradle"), "utf8") : "";
  const projects = [join(android, "app"), ...[...settings.matchAll(/projectDir = new File\('([^']+)'\)/gu)].map(([, path]) => resolve(android, path))];
  const found = new Map();
  for (const project of projects) {
    const file = join(project, "build.gradle");
    if (!existsSync(file)) continue;
    const variables = { ...gradleVariables(file), ...rootVariables };
    for (const [, group, artifact, rawVersion] of readFileSync(file, "utf8").matchAll(/^\s*(?:implementation|api)\s*\(?\s*["']([\w.-]+):([\w.-]+):([^"']+)["']/gmu)) {
      const version = rawVersion.replace(/\$\{?(\w+)\}?/gu, (whole, name) => variables[name] ?? whole);
      if (version.includes("$")) continue;
      const coordinate = `${group}:${artifact}`;
      const users = found.get(coordinate)?.usedBy ?? new Set();
      users.add(relative(ROOT, project));
      found.set(coordinate, { name: coordinate, version, platform: "Android", usedBy: users });
    }
  }
  const spm = join(MOBILE, "ios", "App", "CapApp-SPM", "Package.swift");
  if (existsSync(spm)) {
    for (const [, url, version] of readFileSync(spm, "utf8").matchAll(/\.package\(url:\s*"([^"]+)",\s*(?:exact|from):\s*"([^"]+)"\)/gu)) {
      found.set(url, { name: url.replace(/^https:\/\/github\.com\//u, "").replace(/\.git$/u, ""), version, platform: "iOS", usedBy: new Set([relative(ROOT, spm)]) });
    }
  }
  return [...found.values()].map((library) => {
    const terms = NATIVE_TERMS.find(([pattern]) => pattern.test(library.name));
    return { ...library, license: terms?.[1] ?? "UNKNOWN", repository: terms?.[2], note: terms?.[3] };
  }).sort((left, right) => left.platform.localeCompare(right.platform) || left.name.localeCompare(right.name));
}

/** The kind of a licence expression: the best of its OR alternatives, each as bad as its worst AND term. */
function classify(expression) {
  const term = (raw) => {
    const id = raw.replace(/[()]/gu, "").trim().replace(/^Apache[\s-]*(?:License[\s,]*)?(?:Version\s*)?2(?:\.0)?$/iu, "Apache-2.0");
    if (ATTRIBUTION.test(id)) return 1;
    if (PERMISSIVE.test(id)) return 0;
    if (WEAK_COPYLEFT.test(id)) return 2;
    if (STRONG_COPYLEFT.test(id)) return 3;
    return 4;
  };
  const alternatives = expression.split(/\s+OR\s+|\//iu).map((alternative) => Math.max(...alternative.split(/\s+AND\s+/iu).map(term)));
  return RANK[Math.min(...alternatives)];
}

function histogram(list) {
  const counts = new Map();
  for (const { license } of list) counts.set(license, (counts.get(license) ?? 0) + 1);
  return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).map(([license, count]) => `${license} ${count}`).join(", ");
}

const fence = (text) => "`".repeat(Math.max(3, ...[...text.matchAll(/`+/gu)].map(([run]) => run.length + 1)));
const cell = (value) => String(value ?? "").replace(/\|/gu, "\\|").replace(/\n/gu, " ");

function render({ version, packages, bundled, native, apacheText }) {
  const desktop = packages.filter((entry) => entry.artifacts.has("desktop"));
  const mobile = packages.filter((entry) => entry.artifacts.has("mobile"));
  const texts = new Map();
  const textId = (text) => {
    let entry = texts.get(text);
    if (!entry) texts.set(text, entry = { id: texts.size + 1, users: [] });
    return entry;
  };
  const refs = (entry) => entry.files.map((file) => {
    const text = textId(file.text);
    text.users.push(`${entry.name}@${entry.version} (${file.name})`);
    return `[${file.name}](#text-${text.id})`;
  }).join(", ") || "none in the package";

  const lines = [
    "# Third-party notices",
    "",
    `Tau ${version} is built on the software listed here. Each component keeps its own licence; the texts it asks to be passed on follow at the end.`,
    "Generated by `scripts/open-source/third-party-notices.mjs` from the installed dependencies.",
    "",
    "| Artifact | Packages | Licences |",
    "| --- | --- | --- |",
    `| Desktop app (Electron; kits included) | ${desktop.length} | ${histogram(desktop)} |`,
    `| Mobile app (iOS, Android), JavaScript | ${mobile.length} | ${histogram(mobile)} |`,
    `| Mobile app, native libraries | ${native.length} | ${histogram(native)} |`,
    "",
    "The desktop app runs on Electron. Electron's licence and Chromium's notices ship with the app as `LICENSE.electron.txt` and `LICENSES.chromium.html` (on macOS in `Contents/Resources`).",
    "",
    "## Bundled files",
    "",
    "| File | Version | Licence | Source | Text |",
    "| --- | --- | --- | --- | --- |",
    ...bundled.map((entry) => `| ${cell(entry.name)} | ${cell(entry.version)} | ${entry.license} | ${entry.repository ?? ""} | ${refs(entry)} |`),
    "",
    "## Programs inside packages",
    "",
    "| Program | Version | Licence | Source | Shipped inside |",
    "| --- | --- | --- | --- | --- |",
    ...VENDORED.map((entry) => `| ${cell(entry.name)} | ${entry.version} | ${entry.license} | ${entry.repository} | ${cell(entry.within)} |`),
    "",
    "## Mobile app: native libraries",
    "",
    "Direct dependencies of the Android and iOS projects. Gradle and Swift Package Manager add their own transitive libraries at build time.",
    "",
    "| Library | Version | Platform | Licence | Source | Note |",
    "| --- | --- | --- | --- | --- | --- |",
    ...native.map((library) => `| ${cell(library.name)} | ${library.version} | ${library.platform} | ${cell(library.license)} | ${library.repository ?? ""} | ${cell(library.note)} |`),
    "",
    "Apache Cordova NOTICE:",
    "",
    fence(CORDOVA_NOTICE), CORDOVA_NOTICE, fence(CORDOVA_NOTICE),
    "",
    apacheText ? "The Apache-2.0 text is the one under [Apache License 2.0](#apache-2-0)." : "Apache-2.0: https://www.apache.org/licenses/LICENSE-2.0",
    "",
    "## Packages",
    "",
    "| Package | Version | Licence | Ships in | Repository | Licence files |",
    "| --- | --- | --- | --- | --- | --- |",
    ...packages.map((entry) => `| ${cell(entry.name)} | ${entry.version} | ${cell(entry.license)} | ${[...entry.artifacts].join(", ")} | ${entry.repository ?? ""} | ${refs(entry)} |`),
    "",
    "## Licence texts",
    "",
  ];
  if (apacheText) lines.push('<a id="apache-2-0"></a>', "", "### Apache License 2.0", "", fence(apacheText), apacheText, fence(apacheText), "");
  for (const [text, { id, users }] of texts) {
    lines.push(`<a id="text-${id}"></a>`, "", `### Text ${id}`, "", `Carried by ${users.join(", ")}.`, "", fence(text), text, fence(text), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function main(argv) {
  const outIndex = argv.indexOf("--out");
  const out = resolve(outIndex >= 0 && argv[outIndex + 1] ? argv[outIndex + 1] : DEFAULT_OUT);
  const check = argv.includes("--check");
  const manifest = readPackage(ROOT);
  const entries = new Map();

  const desktopRoots = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}).filter((name) => !collector.BUILD_ONLY_DEV_DEPENDENCIES.has(name)),
  ].map((name) => [name, ROOT]);
  walk(desktopRoots, entries, "desktop");

  const kitFiles = kitSources();
  const kits = reachablePackages(kitFiles);
  walk([...kits.packages, ...loadedByKits(kitFiles)], entries, "kits");

  const mobileEntry = join(MOBILE, "src", "main.tsx");
  const mobileManifest = readPackage(MOBILE) ?? {};
  const mobileGraph = reachablePackages([mobileEntry]);
  const mobileDependencies = Object.entries(mobileManifest.dependencies ?? {}).filter(([, range]) => !String(range).startsWith("file:")).map(([name]) => [name, MOBILE]);
  walk([...mobileGraph.packages, ...mobileDependencies], entries, "mobile");

  const packages = [...entries.values()].sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version, undefined, { numeric: true }));
  const bundled = collector.BUNDLED_FILES.map(({ notice, ...entry }) => {
    const path = join(ROOT, notice);
    return { ...entry, artifacts: new Set(["desktop", "mobile"]), files: existsSync(path) ? [{ name: notice.split("/").pop(), text: readFileSync(path, "utf8").trim() }] : [] };
  });
  const native = nativeLibraries();
  const ownLicense = existsSync(join(ROOT, "LICENSE")) ? readFileSync(join(ROOT, "LICENSE"), "utf8").trim() : "";
  const apacheText = /^\s*Apache License\s+Version 2\.0/u.test(ownLicense) ? ownLicense : undefined;

  const markdown = render({ version: manifest.version, packages, bundled, native, apacheText });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, markdown);

  // Review list: anything not plainly permissive, missing notices, and drift from the in-app list.
  const warnings = [];
  for (const entry of [...packages, ...native, ...VENDORED]) {
    const kind = classify(entry.license);
    if (kind === "permissive") continue;
    const reviewed = REVIEWED.get(entry.name);
    const where = entry.artifacts ? [...entry.artifacts].join(", ") : entry.platform ?? entry.within;
    warnings.push({ reviewed: Boolean(reviewed), line: `${kind}: ${entry.name}@${entry.version} (${entry.license}) in ${where}${reviewed ? ` — reviewed: ${reviewed}` : ""}` });
  }
  const withoutText = packages.filter((entry) => entry.files.length === 0);
  const apacheNotices = packages.filter((entry) => entry.files.some((file) => /^notice/iu.test(file.name)));
  const inApp = new Set(collector.collectThirdPartyLicenses(ROOT).map((entry) => `${entry.name}@${entry.version}`));
  const desktopKeys = new Set(packages.filter((entry) => entry.artifacts.has("desktop")).map((entry) => `${entry.name}@${entry.version}`));
  const onlyInApp = [...inApp].filter((key) => !desktopKeys.has(key));
  const kitsOutsideDesktop = packages.filter((entry) => entry.artifacts.has("kits") && !entry.artifacts.has("desktop"));

  const count = (name) => packages.filter((entry) => entry.artifacts.has(name)).length;
  const log = (line = "") => process.stderr.write(`${line}\n`);
  log(`Wrote ${out} (${markdown.length} bytes): desktop ${count("desktop")} packages (kits use ${count("kits")}), mobile ${count("mobile")} packages + ${native.length} native libraries.`);
  log(`Scanned ${kits.files} kit files and ${mobileGraph.files} files reachable from mobile/src/main.tsx.`);
  if (warnings.length > 0) {
    log(`\nNeeds a licence review (${warnings.filter((warning) => !warning.reviewed).length} open):`);
    for (const warning of warnings) log(`  ${warning.reviewed ? "ok " : "!! "}${warning.line}`);
  }
  if (apacheNotices.length > 0) log(`\nNOTICE files carried (Apache-2.0 §4(d)): ${apacheNotices.map((entry) => `${entry.name}@${entry.version}`).join(", ")}`);
  if (withoutText.length > 0) log(`\nNo licence file in the package (${withoutText.length}): ${withoutText.map((entry) => `${entry.name}@${entry.version} (${entry.license})`).join(", ")}`);
  if (onlyInApp.length > 0) log(`\nIn the in-app list but not packaged: ${onlyInApp.join(", ")}`);
  if (kitsOutsideDesktop.length > 0) log(`\nKits reach packages the desktop list lacks: ${kitsOutsideDesktop.map((entry) => entry.name).join(", ")}`);
  const unresolved = [...kits.unresolved, ...mobileGraph.unresolved];
  if (unresolved.length > 0) log(`\nImports the scan could not follow (${unresolved.length}): ${unresolved.slice(0, 10).join("; ")}`);
  if (check && warnings.some((warning) => !warning.reviewed)) process.exitCode = 1;
}

main(process.argv.slice(2));
