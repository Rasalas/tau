import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Markdown, type MarkdownComponents, type MarkdownHtml } from "tau";
import type { Element, ElementContent, Root } from "hast";
import type { PullRequestClient } from "./pull-request-client.js";
import type { PullRequestRef } from "./protocol.js";
import { githubHtml } from "./github-html.js";
import { requestMediaSource, requestMediaType } from "./request-media.js";

interface MediaScope {
  ref: PullRequestRef;
  load(source: string, retry: boolean): Promise<{ url: string; video: boolean }>;
}
const Scope = createContext<MediaScope | undefined>(undefined);

/** One request's resource leases; closing or switching it revokes every capability. */
export function RequestMediaProvider({ client, request, children }: { client: Pick<PullRequestClient, "media" | "releaseMedia">; request: PullRequestRef; children: ReactNode }) {
  const scope = useMemo(() => {
    const cache = new Map<string, Promise<{ url: string; video: boolean }>>();
    const paths = new Set<string>();
    const bySource = new Map<string, string>();
    let closed = false;
    const release = (path: string) => { void client.releaseMedia?.(path).catch(() => undefined); };
    return {
      ref: request,
      load(source: string, retry: boolean) {
        if (!client.media) return Promise.reject(new Error("This host does not support request uploads."));
        if (retry) {
          cache.delete(source);
          const previous = bySource.get(source);
          if (previous) { release(previous); paths.delete(previous); bySource.delete(source); }
        }
        let read = cache.get(source);
        if (!read) {
          read = client.media(request.url, source).then((result) => {
            if (closed || cache.get(source) !== read) { release(result.path); throw new Error("Request closed or upload replaced."); }
            paths.add(result.path);
            bySource.set(source, result.path);
            return { url: result.url, video: result.mimeType?.startsWith("video/") ?? false };
          });
          cache.set(source, read);
          void read.catch(() => { if (cache.get(source) === read) cache.delete(source); });
        }
        return read;
      },
      open() { closed = false; },
      close() { closed = true; for (const path of paths) release(path); paths.clear(); bySource.clear(); cache.clear(); },
    };
  }, [client, request.url, request.host, request.repo, request.service]);
  useEffect(() => { scope.open(); return () => scope.close(); }, [scope]);
  return <Scope.Provider value={scope}>{children}</Scope.Provider>;
}

function RequestMedia({ src = "", alt = "", title, width, height, video = false }: { src?: string; alt?: string; title?: string; width?: string | number; height?: string | number; video?: boolean }) {
  const scope = useContext(Scope);
  const player = useRef<HTMLVideoElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ scope: MediaScope; src: string; url?: string; video?: boolean; error?: string }>();
  const known = scope && requestMediaSource(src, scope.ref);
  const original = known?.url ?? src;
  const fallback = /^https:\/\//iu.test(original) ? original : undefined;
  useEffect(() => {
    if (!scope || !known) return;
    let alive = true;
    void scope.load(src, attempt > 0).then(
      (value) => { if (alive) setResult({ scope, src, ...value }); },
      () => { if (alive) setResult({ scope, src, ...(fallback ? { url: fallback } : { error: "Upload could not be loaded." }) }); },
    );
    return () => { alive = false; };
  }, [scope, src, Boolean(known), attempt, fallback]);
  const current = result && result.scope === scope && result.src === src ? result : undefined;
  const external = /^https?:\/\//iu.test(src);
  const isVideo = video || current?.video || requestMediaType(known?.kind === "gitlab" ? known.fileName : src)?.startsWith("video/");
  const url = current?.url ?? (!known && external ? src : undefined);
  useEffect(() => {
    const videoElement = player.current;
    return () => { if (videoElement) { videoElement.pause(); videoElement.removeAttribute("src"); videoElement.load(); } };
  }, [url, isVideo]);
  const failure = () => { if (scope) setResult({ scope, src, ...(fallback && url !== fallback ? { url: fallback } : { error: "Upload could not be displayed." }) }); };
  const retry = () => { setResult(undefined); setAttempt((value) => value + 1); };
  return <span className="pr-markdown-media">
    {url && !current?.error ? isVideo
      ? <video key={url} ref={player} src={url} controls preload="metadata" aria-label={alt || "Uploaded video"} title={title} onError={failure} />
      : <img src={url} alt={alt} title={title} width={width} height={height} onError={failure} />
      : <span role={isVideo ? "status" : "img"} aria-label={`${alt || "Upload"}: ${current?.error ?? (known ? "Loading upload…" : "Upload unavailable.")}`}>{current?.error ?? (known ? "Loading upload…" : "Upload unavailable.")}</span>}
    {current?.error ? <button type="button" className="mini-button" onClick={retry}>Retry upload</button> : null}
  </span>;
}

const components: MarkdownComponents = {
  img: ({ src, alt, title, width, height }) => <RequestMedia src={typeof src === "string" ? src : undefined} alt={alt} title={title} width={width} height={height} />,
  video: ({ src, title }) => <RequestMedia src={src} title={title} video />,
};

function mediaHtml(ref: PullRequestRef): MarkdownHtml {
  return (raw: Root) => {
    const tree = githubHtml(raw);
    const visit = (children: ElementContent[]) => {
      for (const node of children) {
        if (node.type !== "element") continue;
        if (node.tagName === "video" && !node.properties.src) {
          const source = node.children.find((child): child is Element => child.type === "element" && child.tagName === "source");
          if (source?.properties.src) node.properties.src = source.properties.src;
          node.children = [];
        }
        if (node.tagName === "a" && typeof node.properties.href === "string") {
          const source = requestMediaSource(node.properties.href, ref);
          const bareGitHubVideo = source?.kind === "github" && node.children.length === 1 && node.children[0]?.type === "text" && node.children[0].value === node.properties.href;
          if (bareGitHubVideo || source?.kind === "gitlab" && requestMediaType(source.fileName)?.startsWith("video/")) {
            node.tagName = "video";
            node.properties = { src: node.properties.href };
            node.children = [];
          }
        }
        visit(node.children);
      }
    };
    visit(tree.children as ElementContent[]);
    return tree;
  };
}

/** Keep GitHub's HTML policy, with media owned by the request rather than a workspace. */
export function RequestMarkdown({ children, html = githubHtml }: { children: string; html?: MarkdownHtml }) {
  const scope = useContext(Scope);
  const policy = useMemo(() => scope ? mediaHtml(scope.ref) : html, [scope, html]);
  return <Markdown html={policy} components={scope ? components : undefined}>{children}</Markdown>;
}
