import type { Root, RootContent } from "mdast";

/** One top-level Markdown block of a streamed message. */
export interface MarkdownBlock {
  /** Offset of the line the block starts on; stable while the text grows. */
  start: number;
  /** From the block's first line to its last character, so it parses alone to the same node. */
  source: string;
  /** Settled blocks never change again while the text only grows. */
  settled: boolean;
  /** A top-level fenced or indented code block, read the way the renderer's `pre` override reads it. */
  code?: { value: string; language?: string; closed: boolean };
}

interface OpenFence {
  /** Offset of the opening line; the region starts here. */
  start: number;
  marker: string;
  language?: string;
  /** Offset just after the opening line's newline. */
  contentStart: number;
  /** Offset of the first line not yet checked for a closing fence. */
  scanned: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const UNINDENTED_FENCE = /^(`{3,}|~{3,})/u;

function hasDefinitions(node: Root | RootContent): boolean {
  return node.type === "definition"
    || node.type === "footnoteDefinition"
    || ("children" in node && node.children.some(hasDefinitions));
}

function lineStart(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

function languageOf(lang: string | null | undefined): string | undefined {
  // Same result as mdast-util-to-hast's `language-<first word>` class read back by `pre`.
  const first = lang?.split(/\s+/u)[0];
  return first ? /^([\w-]+)/u.exec(first)?.[1] : undefined;
}

/** `prefix` also accepts a line that is still too short to close the fence. */
function isClosingFence(line: string, marker: string, prefix = false): boolean {
  const indent = /^ {0,3}/u.exec(line)![0].length;
  const rest = line.slice(indent).replace(/[ \t]+$/u, "");
  return rest.length > 0 && (prefix || rest.length >= marker.length) && [...rest].every((char) => char === marker[0]);
}

/**
 * Splits a growing Markdown message into top-level blocks and parses only the
 * part after the last settled block. A block settles once the parser has
 * started a sibling after it on a complete line: CommonMark never reopens a
 * closed block, so the rest of the stream cannot change it. Definitions are
 * document-wide, so a message with one renders as one document.
 */
export class StreamingMarkdownBlocks {
  private settled: MarkdownBlock[] = [];
  private settledSource = "";
  private fence: OpenFence | undefined;
  private whole = false;
  private finished = false;
  private last: { text: string; final: boolean; blocks: readonly MarkdownBlock[] | undefined } | undefined;
  /** Characters handed to the parser, for tests that guard against reparsing settled text. */
  parsedCharacters = 0;

  constructor(private readonly parse: (source: string) => Root) {}

  /** `undefined` means: render the whole text as one document. */
  update(text: string, final: boolean): readonly MarkdownBlock[] | undefined {
    if (this.last?.text === text && this.last.final === final) return this.last.blocks;
    if (!text.startsWith(this.settledSource) || (this.finished && !final)) this.reset();
    const blocks = this.whole ? undefined : this.segment(text, final);
    this.finished = final;
    this.last = { text, final, blocks };
    return blocks;
  }

  private reset(): void {
    this.settled = [];
    this.settledSource = "";
    this.fence = undefined;
    this.whole = false;
    this.finished = false;
  }

  private segment(text: string, final: boolean): readonly MarkdownBlock[] | undefined {
    const offset = this.settledSource.length;
    const region = text.slice(offset);
    // A streamed CR can become half of a CRLF, and a BOM is only stripped at the document start.
    if (region.includes("\r") || region.includes("\uFEFF")) {
      this.whole = true;
      return undefined;
    }
    if (!final && this.fence?.start === offset) {
      const open = this.openFenceBlock(text);
      if (open) return [...this.settled, open];
    }
    this.fence = undefined;
    this.parsedCharacters += region.length;
    const tree = this.parse(region);
    if (hasDefinitions(tree)) {
      this.whole = true;
      return undefined;
    }
    const children = tree.children.filter((child) => child.position?.start.offset !== undefined);
    // Settle every block before the last one that starts on a complete line.
    let firstOpen = final ? children.length : 0;
    if (!final) {
      for (let index = children.length - 1; index > 0; index -= 1) {
        if (region.includes("\n", children[index]!.position!.start.offset)) {
          firstOpen = index;
          break;
        }
      }
    }
    const toBlock = (child: RootContent, settled: boolean) => this.block(region, offset, child, settled);
    this.settled.push(...children.slice(0, firstOpen).map((child) => toBlock(child, true)));
    const open = children.slice(firstOpen).map((child) => toBlock(child, false));
    if (final) {
      this.settledSource = text;
    } else if (open[0]) {
      this.settledSource = text.slice(0, open[0].start);
      this.fence = open.length === 1 ? this.trackFence(text, open[0]) : undefined;
    }
    return [...this.settled, ...open];
  }

  private block(region: string, offset: number, child: RootContent, settled: boolean): MarkdownBlock {
    const first = lineStart(region, child.position!.start.offset!);
    const end = child.position!.end.offset!;
    const source = region.slice(first, end);
    const block: MarkdownBlock = { start: offset + first, source, settled };
    if (child.type === "code") {
      const lines = source.split("\n");
      const marker = FENCE.exec(lines[0]!)?.[1];
      // Only a fence can close; an indented block's content is final once it settles.
      const closed = Boolean(marker && lines.length > 1 && isClosingFence(lines.at(-1)!, marker));
      block.code = { value: child.value, language: languageOf(child.lang), closed };
    }
    return block;
  }

  /** Only an unindented fence takes the fast path: its content needs no indentation stripped. */
  private trackFence(text: string, block: MarkdownBlock): OpenFence | undefined {
    if (!block.code || block.code.closed) return undefined;
    const newline = block.source.indexOf("\n");
    const marker = newline < 0 ? undefined : UNINDENTED_FENCE.exec(block.source)?.[1];
    if (!marker) return undefined;
    const contentStart = block.start + newline + 1;
    // The parser has seen every complete line; only the partial last one is unchecked.
    return { start: block.start, marker, language: block.code.language, contentStart, scanned: Math.max(contentStart, lineStart(text, text.length)) };
  }

  /** Extends an open fence by scanning only the lines that arrived since the last update. */
  private openFenceBlock(text: string): MarkdownBlock | undefined {
    const fence = this.fence!;
    let position = fence.scanned;
    for (let newline = text.indexOf("\n", position); newline >= 0; newline = text.indexOf("\n", position)) {
      if (isClosingFence(text.slice(position, newline), fence.marker)) return undefined;
      position = newline + 1;
    }
    fence.scanned = position;
    const partial = text.slice(position);
    // A closing fence also closes without its newline at the end of the text.
    if (isClosingFence(partial, fence.marker)) return undefined;
    // Hide a half-typed closing fence rather than flash it as code.
    const content = text.slice(fence.contentStart, isClosingFence(partial, fence.marker, true) ? position : text.length);
    return {
      start: fence.start,
      source: text.slice(fence.start),
      settled: false,
      code: { value: content.endsWith("\n") ? content.slice(0, -1) : content, language: fence.language, closed: false },
    };
  }
}
