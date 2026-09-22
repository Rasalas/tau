import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Processor } from "unified";

/** `remark-gfm` without its serializer half, which Tau never runs: Markdown is only ever parsed here. */
export const remarkGfm = function remarkGfm(this: Processor): void {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(gfm());
  (data.fromMarkdownExtensions ??= []).push(gfmFromMarkdown());
};
