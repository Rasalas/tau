import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { extractIcnsPng } from "./icns.js";

const MAX_ICON_BYTES = 1024 * 1024;
const MAX_ICON_SOURCE_BYTES = 256 * 1024;
/** An `.icns` holds every size up to 1024 px; only one small PNG of it leaves this file. */
const MAX_ICNS_BYTES = 16 * 1024 * 1024;
/** The sidebar draws a project icon at a fraction of this. */
const ICNS_MIN_WIDTH = 96;

const ICON_MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".icns", "image/png"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

/** Ordered from explicit favicon names to broader app-icon conventions. */
export const PROJECT_ICON_CANDIDATES = [
  "favicon.ico",
  "favicon.svg",
  "favicon.png",
  "public/favicon.ico",
  "public/favicon.svg",
  "public/favicon.png",
  "public/apple-touch-icon.png",
  "static/favicon.ico",
  "static/favicon.svg",
  "static/favicon.png",
  "app/favicon.ico",
  "app/icon.svg",
  "app/icon.png",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "icon.svg",
  "icon.png",
  "build/icon.icns",
  "resources/icon.icns",
  "assets/icon.icns",
  "icon.icns",
] as const;

const ICON_SOURCE_FILES = ["index.html", "public/index.html", "src/index.html"] as const;

/** Folders a web or app project keeps its icon in; each is listed once rather than probed per spelling. */
const ICON_FOLDERS = ["", "public", "static", "app", "src/app", "src", "assets", "src/assets", "public/icons", "public/images", "static/icons", "resources", "build"] as const;
/** favicon-32x32.png, icon.webp, apple-icon.png, apple-touch-icon-180x180-precomposed.png … */
const ICON_FILE_NAME = /^(favicon|icon|apple-icon|apple-touch-icon)(?:[-_.@]?\d+(?:x\d+)?)?(?:-precomposed)?\.([a-z]+)$/iu;
const NAME_RANK = ["favicon", "icon", "apple-icon", "apple-touch-icon"];
/** Scalable first, then the formats that draw sharpest small. */
const EXTENSION_RANK = [".svg", ".png", ".webp", ".avif", ".ico", ".gif", ".jpg", ".jpeg", ".icns"];
const MANIFEST_FILES = ["site.webmanifest", "manifest.webmanifest", "manifest.json", "public/site.webmanifest", "public/manifest.webmanifest", "public/manifest.json", "static/site.webmanifest", "static/manifest.json", "app/manifest.json", "app/manifest.webmanifest"] as const;

function staysWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

/** `iconPath` from `t3.json`, the project-icon file some other tools write. */
async function configuredIconPath(projectPath: string): Promise<string | undefined> {
  try {
    const config = JSON.parse(await readFile(resolve(projectPath, "t3.json"), "utf8")) as { iconPath?: unknown };
    return typeof config.iconPath === "string" && config.iconPath.trim() ? config.iconPath.trim() : undefined;
  } catch {
    return undefined;
  }
}

function tagAttribute(tag: string, name: "href" | "rel"): string | undefined {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "iu"));
  return match?.[2]?.trim();
}

async function linkedIconPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const sourceFile of ICON_SOURCE_FILES) {
    const sourcePath = resolve(root, sourceFile);
    try {
      const metadata = await stat(sourcePath);
      if (!metadata.isFile() || metadata.size > MAX_ICON_SOURCE_BYTES) continue;
      const source = await readFile(sourcePath, "utf8");
      for (const match of source.matchAll(/<link\b[^>]*>/giu)) {
        const rel = tagAttribute(match[0], "rel")?.toLocaleLowerCase().split(/\s+/u) ?? [];
        if (!rel.includes("icon") && !rel.includes("apple-touch-icon")) continue;
        const href = tagAttribute(match[0], "href")?.split(/[?#]/u)[0];
        if (!href || /^(?:data:|https?:|\/\/)/iu.test(href)) continue;
        paths.push(href.startsWith("/")
          ? resolve(root, "public", href.slice(1))
          : resolve(dirname(sourcePath), href));
      }
    } catch {
      // Missing source files are normal for non-web projects.
    }
  }
  return paths;
}

/** Icon-named files in the usual folders (any size or format), and any `.ico` at the root, best first. */
async function conventionalIconPaths(root: string): Promise<string[]> {
  const found: Array<{ path: string; folder: number; name: number; extension: number; size: number }> = [];
  for (const [folder, directory] of ICON_FOLDERS.entries()) {
    let names: string[];
    try { names = await readdir(resolve(root, directory)); } catch { continue; }
    for (const name of names) {
      const match = ICON_FILE_NAME.exec(name);
      const extension = extname(name).toLocaleLowerCase();
      if (!ICON_MIME_TYPES.has(extension) || (!match && !(directory === "" && extension === ".ico"))) continue;
      const size = Number(/(\d+)(?:x\d+)?(?:-precomposed)?\.[a-z]+$/iu.exec(name)?.[1] ?? 0);
      found.push({ path: directory ? `${directory}/${name}` : name, folder, name: match ? NAME_RANK.indexOf(match[1]!.toLocaleLowerCase()) : NAME_RANK.length, extension: EXTENSION_RANK.indexOf(extension), size });
    }
  }
  return found
    .sort((a, b) => a.name - b.name || a.folder - b.folder || a.extension - b.extension || b.size - a.size || a.path.localeCompare(b.path))
    .map((entry) => entry.path);
}

/** The icons a web app manifest lists, largest first; `/x` is served from `public/`. */
async function manifestIconPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const manifestFile of MANIFEST_FILES) {
    const manifestPath = resolve(root, manifestFile);
    try {
      const metadata = await stat(manifestPath);
      if (!metadata.isFile() || metadata.size > MAX_ICON_SOURCE_BYTES) continue;
      const icons = (JSON.parse(await readFile(manifestPath, "utf8")) as { icons?: unknown } | null)?.icons;
      if (!Array.isArray(icons)) continue;
      const listed = icons.flatMap((icon: { src?: unknown; sizes?: unknown }) => {
        const src = typeof icon?.src === "string" ? icon.src.split(/[?#]/u)[0] : undefined;
        if (!src || /^(?:data:|https?:|\/\/)/iu.test(src)) return [];
        const sizes = typeof icon.sizes === "string" ? icon.sizes.split(/\s+/u).map((size) => Number(size.split("x")[0]) || (size === "any" ? 4096 : 0)) : [0];
        return [{ path: src.startsWith("/") ? resolve(root, "public", src.slice(1)) : resolve(dirname(manifestPath), src), size: Math.max(0, ...sizes) }];
      });
      paths.push(...listed.sort((a, b) => b.size - a.size).map((entry) => entry.path));
    } catch {
      // No manifest, or one that is not JSON: nothing to follow.
    }
  }
  return paths;
}

async function iconDataUrl(root: string, candidate: string): Promise<string | undefined> {
  const mime = ICON_MIME_TYPES.get(extname(candidate).toLocaleLowerCase());
  if (!mime) return undefined;
  try {
    const path = await realpath(resolve(root, candidate));
    if (!staysWithin(root, path)) return undefined;
    const metadata = await stat(path);
    const icns = extname(candidate).toLocaleLowerCase() === ".icns";
    if (!metadata.isFile() || metadata.size > (icns ? MAX_ICNS_BYTES : MAX_ICON_BYTES)) return undefined;
    const file = await readFile(path);
    const contents = icns ? extractIcnsPng(file, ICNS_MIN_WIDTH) : file;
    if (!contents || contents.length > MAX_ICON_BYTES) return undefined;
    return `data:${mime};base64,${Buffer.from(contents).toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** Resolve one project image without exposing its local path to the renderer. */
export async function resolveProjectIcon(projectPath: string): Promise<string | undefined> {
  let root: string;
  try {
    root = await realpath(projectPath);
  } catch {
    return undefined;
  }
  const configured = await configuredIconPath(root);
  const candidates = configured ? [configured, ...PROJECT_ICON_CANDIDATES] : PROJECT_ICON_CANDIDATES;
  for (const candidate of candidates) {
    const icon = await iconDataUrl(root, candidate);
    if (icon) return icon;
  }
  // Then the declared ones (the page's links, the app manifest), then any icon-named file in the usual folders.
  for (const candidate of [...await linkedIconPaths(root), ...await manifestIconPaths(root), ...await conventionalIconPaths(root)]) {
    const icon = await iconDataUrl(root, candidate);
    if (icon) return icon;
  }
  return undefined;
}
