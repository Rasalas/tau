import { Fragment, createContext, memo, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { HLJSApi, LanguageFn } from "highlight.js";
import { StreamingMarkdownBlocks } from "./markdown-blocks";
import { remarkGfm } from "./remark-gfm-parse";
type LanguageDefinition = LanguageFn;

// The core arrives with the first grammar: nothing highlights before one is loaded anyway.
let hljs: HLJSApi | undefined;
let highlighterPromise: Promise<HLJSApi> | undefined;
function loadHighlighter(): Promise<HLJSApi> {
  highlighterPromise ??= import("highlight.js/lib/core").then(({ default: core }) => (hljs = core));
  return highlighterPromise;
}

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
/** The same block grammar used by the renderer, kept synchronous for layout decisions. */
const markdownBlockParser = unified().use(remarkParse).use(remarkGfm).use(remarkBreaks);

export function canonicalHighlightLanguage(language: string): string {
  return LANGUAGE_ALIASES[language] ?? language;
}

/** Uncached: file bodies are large one-offs, unlike streamed code fences. */
export function highlightSource(code: string, language: string): string | undefined {
  const core = hljs;
  if (!core?.getLanguage(language)) return undefined;
  try {
    return core.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return undefined;
  }
}

export function loadHighlightLanguage(language: string): Promise<void> {
  const canonical = LANGUAGE_ALIASES[language] ?? language;
  const existing = languagePromises.get(canonical);
  if (existing) return existing;
  const loader = LANGUAGE_LOADERS[canonical];
  if (!loader) return Promise.resolve();
  const promise = Promise.all([loadHighlighter(), loader()]).then(([core, { default: definition }]) => {
    if (!core.getLanguage(canonical)) core.registerLanguage(canonical, definition);
  });
  languagePromises.set(canonical, promise);
  return promise;
}

/** Byte bound of the syntax cache (UTF-16 key plus markup); a 150 KB block costs about 1.5 MB. */
export const HIGHLIGHT_CACHE_BYTES = 16 * 1024 * 1024;
const highlightCache = new Map<string, string>();
let highlightCacheUsed = 0;
const entryBytes = (key: string, value: string) => 2 * (key.length + value.length);

function readCache(key: string): string | undefined {
  const cached = highlightCache.get(key);
  if (cached !== undefined) {
    highlightCache.delete(key);
    highlightCache.set(key, cached);
  }
  return cached;
}

function writeCache(key: string, value: string): void {
  const bytes = entryBytes(key, value);
  if (bytes > HIGHLIGHT_CACHE_BYTES) return;
  highlightCache.set(key, value);
  highlightCacheUsed += bytes;
  for (const [oldest, markup] of highlightCache) {
    if (highlightCacheUsed <= HIGHLIGHT_CACHE_BYTES) break;
    highlightCache.delete(oldest);
    highlightCacheUsed -= entryBytes(oldest, markup);
  }
}

/** Bounded syntax cache: streaming responses must not retain every intermediate token. */
export function highlightedCode(code: string, language?: string): string | undefined {
  const core = hljs;
  if (!language || !core?.getLanguage(language)) return undefined;
  const key = `${language}\0${code}`;
  const cached = readCache(key);
  if (cached !== undefined) return cached;
  try {
    const highlighted = core.highlight(code, { language, ignoreIllegals: true }).value;
    writeCache(key, highlighted);
    return highlighted;
  } catch {
    return undefined;
  }
}

export function clearHighlightCache(): void {
  highlightCache.clear();
  highlightCacheUsed = 0;
}

export function highlightCacheSize(): number {
  return highlightCache.size;
}

export function highlightCacheBytes(): number {
  return highlightCacheUsed;
}

interface HighlightJob { code: string; language: string; done(html: string | undefined): void }
const highlightQueue: HighlightJob[] = [];
let highlightPumpScheduled = false;

/** Full highlights a streamed message still owes; the renderer benchmark waits for zero. */
export function pendingHighlightCount(): number {
  return highlightQueue.length;
}

function pumpHighlights(): void {
  if (highlightPumpScheduled || highlightQueue.length === 0) return;
  highlightPumpScheduled = true;
  const run = (deadline?: IdleDeadline) => {
    highlightPumpScheduled = false;
    // One job always; more while the idle period lasts.
    const idle = () => deadline !== undefined && deadline.timeRemaining() > 8;
    do {
      const job = highlightQueue.shift()!;
      job.done(highlightedCode(job.code, job.language));
    } while (highlightQueue.length > 0 && idle());
    pumpHighlights();
  };
  // The timeout keeps a busy stream from starving the queue.
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 250 });
  else setTimeout(run, 0);
}

function scheduleHighlight(code: string, language: string, done: (html: string | undefined) => void): () => void {
  const job = { code, language, done };
  highlightQueue.push(job);
  pumpHighlights();
  return () => {
    const index = highlightQueue.indexOf(job);
    if (index >= 0) highlightQueue.splice(index, 1);
  };
}

/**
 * Where a code block sits in a message that streamed: `growing` code can still
 * change; `final` code is complete, and its full highlight runs in idle time
 * instead of inside the commit that completed it. Unset for any other message.
 */
type CodePhase = "growing" | "final";
const StreamedCodePhase = createContext<CodePhase | undefined>(undefined);

/** Growing code re-renders in pieces of about this many characters, cut at line ends. */
const LIVE_PIECE_CHARS = 2_048;
/** Growing code past this offset stays plain until it is complete, which bounds its DOM. */
export const LIVE_HIGHLIGHT_CHARS = 16 * 1024;

const HighlightedLines = memo(function HighlightedLines({ code, language, cache }: { code: string; language?: string; cache: boolean }) {
  // hljs escapes its input, so the produced markup is safe to inject.
  const html = !language ? undefined : cache ? highlightedCode(code, language) : highlightSource(code, language);
  return html === undefined ? <span>{code}</span> : <span dangerouslySetInnerHTML={{ __html: html }} />;
});

/**
 * Growing code in line-aligned pieces. A complete piece is highlighted once, on
 * its own, until the full highlight replaces the block; the open piece
 * re-highlights only its complete lines.
 */
function LiveCode({ code, language }: { code: string; language?: string }) {
  const pieces: ReactNode[] = [];
  for (let position = 0; position < code.length;) {
    const newline = code.indexOf("\n", position + LIVE_PIECE_CHARS);
    const end = newline < 0 ? code.length : newline + 1;
    const piece = code.slice(position, end);
    const pieceLanguage = position < LIVE_HIGHLIGHT_CHARS ? language : undefined;
    if (newline >= 0) {
      pieces.push(<HighlightedLines key={position} code={piece} language={pieceLanguage} cache />);
    } else {
      const lines = piece.lastIndexOf("\n") + 1;
      pieces.push(<span key={position}>
        {lines > 0 ? <HighlightedLines code={piece.slice(0, lines)} language={pieceLanguage} cache={false} /> : null}
        {piece.slice(lines)}
      </span>);
    }
    position = end;
  }
  return pieces;
}

/** The full highlight of complete streamed code, from the cache or from the idle queue. */
function useDeferredHighlight(code: string, language: string | undefined, enabled: boolean): { html?: string } | undefined {
  const [result, setResult] = useState<{ code: string; language: string; html?: string }>();
  const cached = enabled && language ? readCache(`${language}\0${code}`) : undefined;
  const done = enabled && result?.code === code && result.language === language;
  useEffect(() => {
    if (!enabled || !language || cached !== undefined || done) return undefined;
    return scheduleHighlight(code, language, (html) => setResult({ code, language, html }));
  }, [cached, code, done, enabled, language]);
  if (cached !== undefined) return { html: cached };
  return done ? { html: result.html } : undefined;
}

function CodeBlock({ code, language, phase: givenPhase }: { code: string; language?: string; phase?: CodePhase }) {
  const contextPhase = useContext(StreamedCodePhase);
  const phase = givenPhase ?? contextPhase;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const canonicalLanguage = language ? (LANGUAGE_ALIASES[language] ?? language) : undefined;
  const [languageReady, setLanguageReady] = useState(() => Boolean(canonicalLanguage && hljs?.getLanguage(canonicalLanguage)));

  useEffect(() => {
    if (!canonicalLanguage || hljs?.getLanguage(canonicalLanguage)) {
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
    () => languageReady && !phase ? highlightedCode(code, canonicalLanguage) : undefined,
    [canonicalLanguage, code, languageReady, phase],
  );
  const liveLanguage = languageReady && canonicalLanguage && hljs?.getLanguage(canonicalLanguage) ? canonicalLanguage : undefined;
  const deferred = useDeferredHighlight(code, liveLanguage, phase === "final");

  let body: ReactNode;
  if (!phase) {
    body = highlighted ? <code dangerouslySetInnerHTML={{ __html: highlighted }} /> : <code>{code}</code>;
  } else if (deferred?.html !== undefined) {
    body = <code dangerouslySetInnerHTML={{ __html: deferred.html }} />;
  } else if (phase === "final" && languageReady && (deferred || !liveLanguage)) {
    // Highlighting had nothing to offer: the same plain block a finished message shows.
    body = <code>{code}</code>;
  } else {
    body = <code><LiveCode code={code} language={liveLanguage} /></code>;
  }

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
      <pre>{body}</pre>
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

const StreamingChunk = memo(function StreamingChunk({ children }: { children: string }) {
  return <span>{children}</span>;
});

function StreamingTail({ children }: { children: string }) {
  const chunks: string[] = [];
  for (let offset = 0; offset < children.length; offset += 8_192) chunks.push(children.slice(offset, offset + 8_192));
  return <pre className="streaming-tail">{chunks.map((chunk, index) => <StreamingChunk key={index}>{chunk}</StreamingChunk>)}</pre>;
}

/** A growing non-code block past this size streams as raw text: parsing it per token would miss the frame. */
export const LIVE_BLOCK_CHARS = 32 * 1024;

const StreamedBlock = memo(function StreamedBlock({ source, code, language, phase }: { source: string; code?: string; language?: string; phase: CodePhase }) {
  // A top-level code block renders what `pre` would, without parsing it per token.
  if (code !== undefined) return <CodeBlock code={code} language={language} phase={phase} />;
  if (phase === "growing" && source.length > LIVE_BLOCK_CHARS) return <StreamingTail>{source}</StreamingTail>;
  return <StreamedCodePhase.Provider value={phase}><MarkdownTree>{source}</MarkdownTree></StreamedCodePhase.Provider>;
});

const parseBlocks = (source: string) => markdownBlockParser.parse(source);

/**
 * A message keeps this renderer once it has streamed, so the end of the stream
 * re-renders only its open blocks. Blocks are joined by the newline a one-document
 * render puts between top-level elements, which keeps the DOM identical to it.
 */
function StreamedMarkdown({ text, live }: { text: string; live: boolean }) {
  const [segmenter] = useState(() => new StreamingMarkdownBlocks(parseBlocks));
  const blocks = segmenter.update(text, !live);
  if (!blocks) {
    return <div className="markdown">
      <StreamedCodePhase.Provider value={live ? "growing" : "final"}><MarkdownTree>{text}</MarkdownTree></StreamedCodePhase.Provider>
    </div>;
  }
  return <div className="markdown">
    {blocks.map((block, index) => <Fragment key={block.start}>
      {index > 0 ? "\n" : null}
      <StreamedBlock
        source={block.source}
        code={block.code?.value}
        language={block.code?.language}
        phase={!live || block.settled || block.code?.closed ? "final" : "growing"}
      />
    </Fragment>)}
  </div>;
}

/** Block Markdown must keep its block DOM; only a simple inline instruction can sit beside a chip. */
export function isInlineMarkdown(text: string): boolean {
  try {
    const tree = markdownBlockParser.parse(text);
    // A chip can share a line only with a single paragraph. This lets the
    // actual GFM AST classify tables (including one-column tables), lists,
    // fenced/indented code, block quotes, HTML blocks, and thematic breaks;
    // none can accidentally end up inside a span wrapper.
    if (tree.children.length !== 1 || tree.children[0]?.type !== "paragraph") return false;
    // CommonMark treats indentation after a non-blank paragraph as a lazy
    // continuation. Keep it block-shaped anyway so the user's source
    // indentation remains visible rather than collapsing in an inline span.
    return !text.split(/\r?\n/u).some((line, index) => index > 0 && /^ {4}/u.test(line));
  } catch {
    // A parser failure must preserve valid DOM structure: block rendering is
    // the safe fallback and never places unknown content in a span.
    return false;
  }
}

/** A message that streamed parses each completed block once and keeps those blocks after the stream ends. */
export const Markdown = memo(function Markdown({ children, streaming = false, inlineStart = false }: { children: string; streaming?: boolean; inlineStart?: boolean }) {
  const [streamed, setStreamed] = useState(streaming);
  if (streaming && !streamed) setStreamed(true);
  if (inlineStart && !streaming && isInlineMarkdown(children)) {
    return <span className="markdown markdown-inline"><MarkdownTree components={INLINE_COMPONENTS}>{children}</MarkdownTree></span>;
  }
  if (!streaming && !streamed) {
    return <div className="markdown"><MarkdownTree>{children}</MarkdownTree></div>;
  }
  return <StreamedMarkdown text={children} live={streaming} />;
});
