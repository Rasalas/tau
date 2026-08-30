import { memo, useMemo, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// Each definition also registers its own aliases (ts/tsx, js/jsx, sh, html, yml, …).
for (const [name, language] of Object.entries({
  bash, css, diff, go, javascript, json, markdown, python, rust, shell, sql, typescript, xml, yaml,
})) {
  hljs.registerLanguage(name, language);
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

  // hljs escapes its input, so the produced markup is safe to inject.
  const highlighted = useMemo(() => highlightedCode(code, language), [code, language]);

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
