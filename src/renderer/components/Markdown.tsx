import { memo, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";
type LanguageDefinition = LanguageFn;

const LANGUAGE_LOADERS: Record<string, () => Promise<{ default: LanguageDefinition }>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  go: () => import("highlight.js/lib/languages/go"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  python: () => import("highlight.js/lib/languages/python"),
  rust: () => import("highlight.js/lib/languages/rust"),
  shell: () => import("highlight.js/lib/languages/shell"),
  sql: () => import("highlight.js/lib/languages/sql"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  sh: "shell", zsh: "shell", html: "xml", xhtml: "xml", yml: "yaml",
};
const languagePromises = new Map<string, Promise<void>>();

function loadLanguage(language: string): Promise<void> {
  const canonical = LANGUAGE_ALIASES[language] ?? language;
  const existing = languagePromises.get(canonical);
  if (existing) return existing;
  const loader = LANGUAGE_LOADERS[canonical];
  if (!loader) return Promise.resolve();
  const promise = loader().then(({ default: definition }) => {
    if (!hljs.getLanguage(canonical)) hljs.registerLanguage(canonical, definition);
  });
  languagePromises.set(canonical, promise);
  return promise;
}

export const HIGHLIGHT_CACHE_LIMIT = 96;
const highlightCache = new Map<string, string>();

/** Bounded syntax cache: streaming responses must not retain every intermediate token. */
export function highlightedCode(code: string, language?: string): string | undefined {
  if (!language || !hljs.getLanguage(language)) return undefined;
  const key = `${language}\0${code}`;
  const cached = highlightCache.get(key);
  if (cached !== undefined) {
    highlightCache.delete(key);
    highlightCache.set(key, cached);
    return cached;
  }
  try {
    const highlighted = hljs.highlight(code, { language, ignoreIllegals: true }).value;
    highlightCache.set(key, highlighted);
    if (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) highlightCache.delete(highlightCache.keys().next().value!);
    return highlighted;
  } catch {
    return undefined;
  }
}

export function clearHighlightCache(): void {
  highlightCache.clear();
}

export function highlightCacheSize(): number {
  return highlightCache.size;
}

function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const canonicalLanguage = language ? (LANGUAGE_ALIASES[language] ?? language) : undefined;
  const [languageReady, setLanguageReady] = useState(() => Boolean(canonicalLanguage && hljs.getLanguage(canonicalLanguage)));

  useEffect(() => {
    if (!canonicalLanguage || hljs.getLanguage(canonicalLanguage)) {
      setLanguageReady(true);
      return;
    }
    let cancelled = false;
    setLanguageReady(false);
    void loadLanguage(canonicalLanguage).finally(() => {
      if (!cancelled) setLanguageReady(true);
    });
    return () => { cancelled = true; };
  }, [canonicalLanguage]);

  // hljs escapes its input, so the produced markup is safe to inject.
  const highlighted = useMemo(
    () => languageReady ? highlightedCode(code, canonicalLanguage) : undefined,
    [canonicalLanguage, code, languageReady],
  );

  const copy = () => {
    const settle = (state: "copied" | "failed") => {
      setCopyState(state);
      window.setTimeout(() => setCopyState("idle"), 1400);
    };
    const write = navigator.clipboard?.writeText(code);
    if (!write) { settle("failed"); return; }
    void write.then(() => settle("copied"), () => settle("failed"));
  };

  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{language ?? "text"}</span>
        <button className={copyState} onClick={copy}>
          {copyState === "idle" ? "copy" : copyState}
        </button>
      </div>
      <pre>
        {highlighted
          ? <code dangerouslySetInnerHTML={{ __html: highlighted }} />
          : <code>{code}</code>}
      </pre>
    </div>
  );
}

type CodeChild = ReactElement<{ className?: string; children?: ReactNode }>;

const COMPONENTS: Components = {
  // `pre` owns fenced blocks; the nested `code` is read for its text and language
  // and never rendered, so the `code` override below only ever sees inline spans.
  pre({ children }) {
    const child = (Array.isArray(children) ? children[0] : children) as CodeChild | undefined;
    const props = child?.props ?? {};
    const language = /language-([\w-]+)/u.exec(props.className ?? "")?.[1];
    const code = String(props.children ?? "").replace(/\n$/u, "");
    return <CodeBlock code={code} language={language} />;
  },
  a({ href, children }) {
    return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
  },
  table({ children }) {
    return <div className="md-table-scroll"><table>{children}</table></div>;
  },
  // Task-list boxes: a native disabled checkbox cannot be themed, so draw our own.
  input({ type, checked }) {
    if (type !== "checkbox") return null;
    return <span className={`checkbox md-check ${checked ? "on" : ""}`} aria-hidden>✓</span>;
  },
};

/**
 * Renders agent and user text. Raw HTML is deliberately not enabled, so anything
 * HTML-shaped in a model response stays inert text.
 */
const MarkdownTree = memo(function MarkdownTree({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={COMPONENTS}>
      {children}
    </ReactMarkdown>
  );
});

/** Keep the mutable tail cheap; settled paragraphs are parsed only when a boundary is crossed. */
export const Markdown = memo(function Markdown({ children, streaming = false }: { children: string; streaming?: boolean }) {
  if (!streaming || children.length < 512) {
    return <div className="markdown"><MarkdownTree>{children}</MarkdownTree></div>;
  }
  const boundary = children.lastIndexOf("\n\n");
  if (boundary < 0) return <div className="markdown"><pre className="streaming-tail">{children}</pre></div>;
  const settled = children.slice(0, boundary + 2);
  const tail = children.slice(boundary + 2);
  return (
    <div className="markdown">
      <MarkdownTree>{settled}</MarkdownTree>
      <pre className="streaming-tail">{tail}</pre>
    </div>
  );
});
