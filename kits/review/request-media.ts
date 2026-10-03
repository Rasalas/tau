import type { PullRequestRef } from "./protocol.js";

/** Only recognized forge uploads may enter the authenticated media reader. */
export type RequestMediaSource =
  | { kind: "github"; url: string }
  | { kind: "gitlab"; project: string; secret: string; fileName: string; url: string };

export interface RequestMediaResult { path: string; mimeType?: string }

const FILE = /^[^/\\]+$/u;
const PROJECT = /^[\w.-]+(?:\/[\w.-]+)*$/u;

/** GitLab advertises a canonical host that can differ from the CLI login host. */
export function requestMediaSource(source: string, ref: PullRequestRef): RequestMediaSource | undefined {
  try {
    const base = new URL(ref.url);
    if (ref.service === "github") {
      const url = new URL(source);
      if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search
        || !/^\/user-attachments\/assets\/[\w-]+$/u.test(url.pathname)) return;
      url.hash = "";
      return { kind: "github", url: url.toString() };
    }
    if (ref.service !== "gitlab") return;
    const repository = `${base.origin}/${ref.repo}`;
    const url = new URL(/^\/?uploads\//u.test(source) ? `${repository}/${source.replace(/^\//u, "")}` : source, `${repository}/`);
    // Never send this request's credentials to an arbitrary Markdown origin.
    if (url.origin !== base.origin || url.username || url.password || url.search) return;
    const match = /^\/(.+)\/uploads\/([a-f\d]{32})\/([^/]+)$/iu.exec(url.pathname);
    if (!match) return;
    const project = /(?:^|\/)-\/project\/(\d+)$/u.exec(match[1]!)?.[1] ?? decodeURIComponent(match[1]!);
    const fileName = decodeURIComponent(match[3]!);
    if (!PROJECT.test(project) || project.split("/").some((part) => part === "." || part === "..") || !FILE.test(fileName) || Array.from(fileName).some((char) => char.codePointAt(0)! < 32 || char.codePointAt(0) === 127) || fileName === "." || fileName === "..") return;
    url.hash = "";
    return { kind: "gitlab", project, secret: match[2]!, fileName, url: url.toString() };
  } catch { return; }
}

export function requestMediaType(fileName: string): string | undefined {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return ({ svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg" } as Record<string, string>)[extension ?? ""];
}
