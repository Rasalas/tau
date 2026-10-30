import { passiveKind, type PassiveKind } from "./passive-preview.js";

/**
 * How the Files tab draws a file, decided by its name alone: media and PDFs
 * never have their bytes read into the page, and a text file that can be
 * drawn another way, such as Markdown, HTML, a table or a notebook, offers both.
 */
export type FileViewKind = "text" | "pdf" | "image" | "audio" | "video" | PassiveKind;
export type RenderedMode = "markdown" | "html" | "table" | "notebook";

const EXTENSION_KINDS: Record<string, FileViewKind> = {
  pdf: "pdf",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", avif: "image", bmp: "image", ico: "image", svg: "image",
  mp3: "audio", wav: "audio", ogg: "audio", oga: "audio", opus: "audio", m4a: "audio", aac: "audio", flac: "audio",
  mp4: "video", m4v: "video", webm: "video", ogv: "video", mov: "video",
};

function extension(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileViewKind(path: string): FileViewKind {
  return passiveKind(path) ?? EXTENSION_KINDS[extension(path)] ?? "text";
}

/** The other way a text file can be read; `undefined` for plain source. */
export function renderedMode(path: string): RenderedMode | undefined {
  const ext = extension(path);
  if (ext === "md" || ext === "mdx" || ext === "markdown") return "markdown";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "csv" || ext === "tsv") return "table";
  if (ext === "ipynb") return "notebook";
  return undefined;
}

export function tableDelimiter(path: string): "," | "\t" {
  return extension(path) === "tsv" ? "\t" : ",";
}

/**
 * Rendered or source when a file opens: Markdown opens as
 * source, a page, table and notebook rendered. The user's last choice per mode wins.
 */
export const RENDERED_BY_DEFAULT: Record<RenderedMode, boolean> = { markdown: false, html: true, table: true, notebook: true };

/** The label of the toggle, which names what it switches to. */
export function renderedToggleLabel(mode: RenderedMode, rendered: boolean): string {
  if (mode === "markdown") return rendered ? "Show markdown source" : "Show rendered markdown";
  if (mode === "table") return rendered ? "Show source" : "Show table";
  if (mode === "notebook") return rendered ? "Show notebook source" : "Show rendered notebook";
  return rendered ? "Show HTML source" : "Show rendered page";
}
