import { BridgeRefusal, type BridgeDownloadFile, type DisplayMode, type HostContext } from "./mcp-app-bridge.js";
import { MCP_APP_LIMITS } from "./mcp-app-protocol.js";

/** What the window knows about itself, for the app's host context and for saving its files. */

/** The spec's standard variable to the Tau token (a colour or a length) it reads. */
const COLORS: Record<string, string> = {
  "--color-background-primary": "--shell", "--color-background-secondary": "--sunken", "--color-background-tertiary": "--raised",
  "--color-background-inverse": "--ink", "--color-background-ghost": "transparent", "--color-background-info": "--acid-bg",
  "--color-background-danger": "--danger-bg", "--color-background-success": "--diff-add-bg", "--color-background-warning": "--warn-chip",
  "--color-background-disabled": "--wash-2",
  "--color-text-primary": "--ink", "--color-text-secondary": "--ink-3", "--color-text-tertiary": "--muted", "--color-text-inverse": "--shell",
  "--color-text-ghost": "--muted-2", "--color-text-info": "--info-ink", "--color-text-danger": "--danger", "--color-text-success": "--ready",
  "--color-text-warning": "--warn", "--color-text-disabled": "--faint",
  "--color-border-primary": "--line-strong", "--color-border-secondary": "--line-card", "--color-border-tertiary": "--line-soft",
  "--color-border-inverse": "--ink", "--color-border-ghost": "transparent", "--color-border-info": "--acid-line", "--color-border-danger": "--danger-line",
  "--color-border-success": "--done", "--color-border-warning": "--warn-line", "--color-border-disabled": "--line-soft",
  "--color-ring-primary": "--focus", "--color-ring-secondary": "--line-strong", "--color-ring-inverse": "--ink", "--color-ring-info": "--info",
  "--color-ring-danger": "--fail", "--color-ring-success": "--done", "--color-ring-warning": "--warn",
};
const SIZES: Record<string, string> = {
  "--font-text-xs-size": "--text-xs", "--font-text-sm-size": "--text-sm", "--font-text-md-size": "--text-md", "--font-text-lg-size": "--text-lg",
};
const FONTS: Record<string, string> = { "--font-sans": "--sans", "--font-mono": "--mono" };
const RADII: Record<string, string> = {
  "--border-radius-xs": "--radius-xs", "--border-radius-sm": "--radius-sm", "--border-radius-md": "--radius-md",
  "--border-radius-lg": "--radius-lg", "--border-radius-xl": "--radius-xl",
};
const CONSTANTS: Record<string, string> = {
  "--font-weight-normal": "400", "--font-weight-medium": "500", "--font-weight-semibold": "600", "--font-weight-bold": "700",
  "--font-heading-xs-size": "13px", "--font-heading-sm-size": "15px", "--font-heading-md-size": "17px", "--font-heading-lg-size": "20px",
  "--font-heading-xl-size": "24px", "--font-heading-2xl-size": "30px", "--font-heading-3xl-size": "36px",
  "--font-text-xs-line-height": "1.45", "--font-text-sm-line-height": "1.5", "--font-text-md-line-height": "1.5", "--font-text-lg-line-height": "1.45",
  "--font-heading-xs-line-height": "1.3", "--font-heading-sm-line-height": "1.3", "--font-heading-md-line-height": "1.25",
  "--font-heading-lg-line-height": "1.25", "--font-heading-xl-line-height": "1.2", "--font-heading-2xl-line-height": "1.2", "--font-heading-3xl-line-height": "1.15",
  "--border-radius-full": "9999px", "--border-width-regular": "1px",
};

/** Values that came back unresolved (a stylesheet-less document) are left out. */
const usable = (value: string) => value !== "" && !value.includes("var(");

/** The workbench's tokens as the spec's standard variables, with colours resolved for the scheme on screen. */
export function styleVariables(root: HTMLElement = document.documentElement): Record<string, string> {
  const probe = document.createElement("span");
  probe.hidden = true;
  root.appendChild(probe);
  const resolved = (property: "color" | "fontSize", token: string) => {
    probe.style[property] = token.startsWith("--") ? `var(${token})` : token;
    return getComputedStyle(probe)[property].trim();
  };
  const out: Record<string, string> = {};
  try {
    for (const [key, token] of Object.entries(COLORS)) {
      const value = resolved("color", token);
      if (usable(value)) out[key] = value;
    }
    for (const [key, token] of Object.entries(SIZES)) {
      const value = resolved("fontSize", token);
      if (usable(value)) out[key] = value;
    }
    const style = getComputedStyle(root);
    for (const [key, token] of [...Object.entries(FONTS), ...Object.entries(RADII)]) {
      const value = style.getPropertyValue(token).trim();
      if (usable(value)) out[key] = value;
    }
  } finally {
    probe.remove();
  }
  return { ...CONSTANTS, ...out };
}

export interface HostContextInput {
  scheme: "light" | "dark";
  displayMode: DisplayMode;
  fullscreenAvailable: boolean;
  /** The frame's box while inline. */
  width: number;
  /** The frame element's size, asked while in full screen. */
  size: () => { width: number; height: number };
  maxHeight: number;
  profile: "desktop" | "web" | "compact";
  release?: string;
  toolId: string;
  toolDefinition: unknown;
  styles: () => Record<string, string>;
}

const PLATFORM = { desktop: "desktop", web: "web", compact: "mobile" } as const;

const matches = (query: string) => typeof matchMedia === "function" && matchMedia(query).matches;

/** The live host context an app is given; compared field by field, so it must be plain data. */
export function hostContextOf(input: HostContextInput): HostContext {
  const fullscreen = input.displayMode === "fullscreen";
  const size = fullscreen ? input.size() : undefined;
  const containerDimensions = size
    ? { width: size.width, height: size.height }
    : { ...(input.width > 0 ? { width: input.width } : { maxWidth: typeof window === "undefined" ? 1024 : window.innerWidth }), maxHeight: input.maxHeight };
  const tool = input.toolDefinition;
  const named = typeof tool === "object" && tool !== null && typeof (tool as { name?: unknown }).name === "string";
  return {
    theme: input.scheme,
    styles: { variables: input.styles() },
    displayMode: input.displayMode,
    availableDisplayModes: input.fullscreenAvailable ? ["inline", "fullscreen"] : ["inline"],
    containerDimensions,
    locale: typeof navigator === "undefined" ? "en-US" : navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: input.release ? `tau/${input.release}` : "tau",
    platform: PLATFORM[input.profile],
    deviceCapabilities: { touch: matches("(pointer: coarse)"), hover: matches("(hover: hover)") },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...(named ? { toolInfo: { id: input.toolId, tool } } : {}),
  };
}

export interface SavedFile { name: string; mimeType: string; bytes: Uint8Array<ArrayBuffer> }

function decodeBase64(blob: string): Uint8Array<ArrayBuffer> {
  const binary = atob(blob);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** A resource's `text` or `blob` as bytes; over 25 MiB is refused. */
export function resourceBytes(contents: { text?: unknown; blob?: unknown }): Uint8Array<ArrayBuffer> {
  let bytes: Uint8Array<ArrayBuffer>;
  if (typeof contents.text === "string") bytes = new TextEncoder().encode(contents.text);
  else if (typeof contents.blob === "string") {
    if ((contents.blob.length * 3) / 4 > MCP_APP_LIMITS.downloadBytes + 3) throw new BridgeRefusal("A file is larger than 25 MiB.");
    try { bytes = decodeBase64(contents.blob); } catch { throw new Error("The file's data is not valid."); }
  } else throw new Error("The server returned no data for the file.");
  if (bytes.length > MCP_APP_LIMITS.downloadBytes) throw new BridgeRefusal("A file is larger than 25 MiB.");
  return bytes;
}

/** The bytes of a file the app handed over; a link is read through `read`. */
export async function fileBytes(file: BridgeDownloadFile, read: (uri: string) => Promise<unknown>): Promise<SavedFile> {
  if (!file.link) return { name: file.name, mimeType: file.mimeType ?? "application/octet-stream", bytes: resourceBytes(file) };
  const answer = await read(file.uri) as { contents?: Array<{ text?: unknown; blob?: unknown; mimeType?: unknown }> } | null;
  const first = answer?.contents?.[0];
  if (!first) throw new Error("The server returned no data for the file.");
  return { name: file.name, mimeType: file.mimeType ?? (typeof first.mimeType === "string" ? first.mimeType : "application/octet-stream"), bytes: resourceBytes(first) };
}

const REVOKE_AFTER_MS = 60_000;

/** Hands the bytes to the browser's download, through a temporary link. */
export function saveFile(file: SavedFile): void {
  const url = URL.createObjectURL(new Blob([file.bytes], { type: file.mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}
