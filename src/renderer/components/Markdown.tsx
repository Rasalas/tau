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

export function loadHighlightLanguage(language: string): Promise<void> {
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
    void loadHighlightLanguage(canonicalLanguage).finally(() => {
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
const INLINE_COMPONENTS: Components = {
  ...COMPONENTS,
  p({ children }) {
    return <span className="md-inline-paragraph">{children}</span>;
  },
};

const MarkdownTree = memo(function MarkdownTree({ children, components = COMPONENTS }: { children: string; components?: Components }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
      {children}
    </ReactMarkdown>
  );
});

const SettledMarkdownBlock = memo(function SettledMarkdownBlock({ children }: { children: string }) {
  return <MarkdownTree>{children}</MarkdownTree>;
});

const StreamingChunk = memo(function StreamingChunk({ children }: { children: string }) {
  return <span>{children}</span>;
});

function StreamingTail({ children }: { children: string }) {
  const chunks: string[] = [];
  for (let offset = 0; offset < children.length; offset += 8_192) chunks.push(children.slice(offset, offset + 8_192));
  return <pre className="streaming-tail">{chunks.map((chunk, index) => <StreamingChunk key={index}>{chunk}</StreamingChunk>)}</pre>;
}

/** Block Markdown must keep its block DOM; only a simple inline instruction can sit beside a chip. */
export function isInlineMarkdown(text: string): boolean {
  return !/(^|\n)(?:[ \t]{4}|```|~~~| {0,3}(?:#{1,6}\s|[-+*]\s|\d+\.\s|>|\*\*\*+\s*$|---+\s*$))/mu.test(text)
    && !/\n\s*\n/u.test(text);
}

/** Keep the mutable tail cheap and parse each completed block only once. */
export const Markdown = memo(function Markdown({ children, streaming = false, inlineStart = false }: { children: string; streaming?: boolean; inlineStart?: boolean }) {
  if (inlineStart && !streaming && isInlineMarkdown(children)) {
    return <span className="markdown markdown-inline"><MarkdownTree components={INLINE_COMPONENTS}>{children}</MarkdownTree></span>;
  }
  if (!streaming || children.length < 512) {
    return <div className="markdown"><MarkdownTree>{children}</MarkdownTree></div>;
  }
  const blocks = children.split("\n\n");
  const tail = blocks.pop() ?? "";
  return (
    <div className="markdown">
      {blocks.map((block, index) => <SettledMarkdownBlock key={index}>{`${block}\n\n`}</SettledMarkdownBlock>)}
      <StreamingTail>{tail}</StreamingTail>
    </div>
  );
});
