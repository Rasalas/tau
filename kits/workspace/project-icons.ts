import type { PreferencesStore } from "tau";
import { WORKSPACE_HOST_EXTENSION_ID } from "./protocol.js";

/** A project's chosen icon. Every kind keeps the picture it draws as, so a row only shows an `<img>`. */
export type ProjectIconChoice =
  | { kind: "icon"; name: string; hue: number; image: string }
  | { kind: "emoji"; emoji: string; image: string }
  | { kind: "monogram"; text: string; hue: number; image: string }
  | { kind: "image"; image: string };

export const PROJECT_ICON_HUES = [
  { hue: 85, label: "Lime" },
  { hue: 145, label: "Green" },
  { hue: 180, label: "Teal" },
  { hue: 215, label: "Blue" },
  { hue: 265, label: "Violet" },
  { hue: 330, label: "Pink" },
  { hue: 0, label: "Red" },
  { hue: 32, label: "Orange" },
] as const;

export const PROJECT_EMOJIS = ["💻", "🚀", "⚡️", "🧪", "🛠️", "📦", "🌿", "🔥", "🎨", "🧠", "🐛", "📚", "🌐", "🔒", "📈", "🎮", "🤖", "🧩", "✨", "🦀"];

/** Where the choice is kept: the kit's values, which the host syncs to every client. */
export function projectIconKey(project: { workspaceId?: string; path: string }): string {
  return `project-icon:${project.workspaceId ?? project.path}`;
}

type Values = Pick<PreferencesStore, "value">;

function parseChoice(raw: string | undefined): ProjectIconChoice | undefined {
  if (!raw) return undefined;
  try {
    const choice = JSON.parse(raw) as ProjectIconChoice;
    return typeof choice?.image === "string" && choice.image.startsWith("data:image/") ? choice : undefined;
  } catch {
    return undefined;
  }
}

export function readProjectIcon(preferences: Values, project: { workspaceId?: string; path: string }): ProjectIconChoice | undefined {
  return parseChoice(preferences.value(WORKSPACE_HOST_EXTENSION_ID, projectIconKey(project)));
}

const STORED_PREFIX = `${WORKSPACE_HOST_EXTENSION_ID}.${projectIconKey({ path: "" })}`;

/** Every chosen picture by the workspace id or path it was chosen for: what core's `setProjectIcons` takes. */
export function chosenProjectIcons(values: Readonly<Record<string, string>>): Record<string, string> {
  const icons: Record<string, string> = {};
  for (const [key, raw] of Object.entries(values)) {
    const image = key.startsWith(STORED_PREFIX) ? parseChoice(raw)?.image : undefined;
    if (image) icons[key.slice(STORED_PREFIX.length)] = image;
  }
  return icons;
}

/** Hands core the chosen pictures now and whenever one changes, so every project mark draws them. */
export function publishProjectIcons(
  preferences: Pick<PreferencesStore, "getSnapshot" | "subscribe">,
  publish: (icons: Readonly<Record<string, string>> | undefined) => void,
): () => void {
  let values: unknown;
  let published = "";
  const update = () => {
    const next = preferences.getSnapshot().extensionValues;
    if (next === values) return;
    values = next;
    const icons = chosenProjectIcons(next);
    const signature = JSON.stringify(icons);
    if (signature === published) return;
    published = signature;
    publish(icons);
  };
  update();
  const unsubscribe = preferences.subscribe(update);
  return () => { unsubscribe(); publish(undefined); };
}

/** `undefined` goes back to the automatic icon (favicon, `t3.json` or initial). */
export function writeProjectIcon(preferences: Pick<PreferencesStore, "setValue">, project: { workspaceId?: string; path: string }, choice: ProjectIconChoice | undefined): void {
  preferences.setValue(WORKSPACE_HOST_EXTENSION_ID, projectIconKey(project), choice ? JSON.stringify(choice) : "");
}

const escapeXml = (text: string) => text.replace(/[<>&"']/gu, (character) => `&#${character.charCodeAt(0)};`);
const svgUrl = (markup: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
const SVG = `xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32"`;

export function iconColor(hue: number): string {
  return `hsl(${hue} 62% 56%)`;
}

export function emojiImage(emoji: string): string {
  return svgUrl(`<svg ${SVG}><text x="16" y="17" font-size="26" text-anchor="middle" dominant-baseline="central">${escapeXml(emoji)}</text></svg>`);
}

export function monogramImage(text: string, hue: number): string {
  const size = Array.from(text).length > 1 ? 14 : 17;
  return svgUrl(`<svg ${SVG}><rect width="32" height="32" rx="8" fill="hsl(${hue} 42% 36%)"/><text x="16" y="17" fill="#fff" font-family="system-ui,sans-serif" font-weight="600" font-size="${size}" text-anchor="middle" dominant-baseline="central">${escapeXml(text)}</text></svg>`);
}

/** One or two letters or digits. */
export function monogramText(value: string): string | undefined {
  const text = value.normalize("NFKC").trim().toUpperCase();
  return /^[\p{L}\p{N}]{1,2}$/u.test(text) ? text : undefined;
}

/** The first emoji of what was typed or pasted. */
export function firstEmoji(value: string): string | undefined {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(value.trim())) {
    if (/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment)) return segment;
  }
  return undefined;
}

/** A drawn Lucide icon as a picture, in the chosen colour (an `<img>` has no `currentColor`). */
export function svgElementImage(svg: SVGElement, hue: number): string {
  const copy = svg.cloneNode(true) as SVGElement;
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", "32");
  copy.setAttribute("height", "32");
  copy.setAttribute("stroke", iconColor(hue));
  copy.removeAttribute("class");
  return svgUrl(copy.outerHTML);
}

/** A picked image, drawn into 64 px so a config value stays small. */
export async function imageFileImage(file: File, size = 64): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This window cannot draw images.");
    const scale = Math.min(size / image.naturalWidth, size / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}
