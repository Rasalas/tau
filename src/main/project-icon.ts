import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

const MAX_ICON_BYTES = 1024 * 1024;
const MAX_ICON_SOURCE_BYTES = 256 * 1024;

const ICON_MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
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
] as const;

const ICON_SOURCE_FILES = ["index.html", "public/index.html", "src/index.html"] as const;

function staysWithin(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

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
        if (!rel.includes("icon")) continue;
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

async function iconDataUrl(root: string, candidate: string): Promise<string | undefined> {
  const mime = ICON_MIME_TYPES.get(extname(candidate).toLocaleLowerCase());
  if (!mime) return undefined;
  try {
    const path = await realpath(resolve(root, candidate));
    if (!staysWithin(root, path)) return undefined;
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_ICON_BYTES) return undefined;
    const contents = await readFile(path);
    return `data:${mime};base64,${contents.toString("base64")}`;
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
  for (const candidate of await linkedIconPaths(root)) {
    const icon = await iconDataUrl(root, candidate);
    if (icon) return icon;
  }
  return undefined;
}
