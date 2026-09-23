/**
 * The directory a shell says it is in. Shells that know the convention
 * (fish, Ghostty's and VS Code's shell integration, many prompts) print
 * `ESC ] 7 ; file://host/path` after every prompt; the sequence may arrive
 * split across output chunks.
 */

const START = "\u001b]7;";
/** A report longer than this is no path; the tail is dropped instead of growing. */
const MAX_REPORT = 4096;
const REPORT = /\u001b\]7;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/gu;

/**
 * The path a `file://` URL names, if it names one on this machine: an empty
 * host, `localhost` or this machine's name. A shell reached over ssh reports
 * the far machine's paths, which mean nothing here.
 */
export function osc7Path(url: string, hostname: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const match = /^file:\/\/([^/]*)(\/.*)$/u.exec(url.trim());
  if (!match) return undefined;
  const host = match[1]!.toLowerCase();
  const local = hostname.toLowerCase();
  if (host && host !== "localhost" && host !== local && host !== local.split(".")[0]) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(match[2]!);
  } catch {
    return undefined;
  }
  if (path.includes("\0")) return undefined;
  if (platform === "win32") {
    const drive = /^\/([A-Za-z]:)(\/.*)?$/u.exec(path);
    return drive ? `${drive[1]}${(drive[2] ?? "/").replace(/\//gu, "\\")}` : undefined;
  }
  return path.length > 1 ? path.replace(/\/+$/u, "") : path;
}

/** Follows one shell's output and answers with the last directory it reported. */
export class CwdTracker {
  private tail = "";

  constructor(
    private readonly hostname: string,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** The directory the newest complete report in this chunk names, if there is one. */
  feed(data: string): string | undefined {
    const text = this.tail + data;
    this.tail = "";
    if (!text.includes("\u001b")) return undefined;
    let found: string | undefined;
    let end = 0;
    for (const match of text.matchAll(REPORT)) {
      const path = osc7Path(match[1]!, this.hostname, this.platform);
      if (path) found = path;
      end = match.index + match[0].length;
    }
    // What may be the start of a report the next chunk finishes.
    const started = text.lastIndexOf(START);
    if (started >= end) {
      if (text.length - started <= MAX_REPORT) this.tail = text.slice(started);
    } else {
      const open = text.lastIndexOf("\u001b");
      if (open >= end && START.startsWith(text.slice(open))) this.tail = text.slice(open);
    }
    return found;
  }
}
