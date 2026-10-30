const FRONTMATTER = /^\uFEFF?---[ \t]*(?:\r\n|\r|\n)(?:[\s\S]*?(?:\r\n|\r|\n))?(?:---|\.\.\.)[ \t]*(?=\r\n|\r|\n|$)/u;

/** Hide file metadata in previews, retaining line numbers and source offsets. */
export function maskMarkdownFrontmatter(text: string): string {
  return text.replace(FRONTMATTER, (metadata) => metadata.replace(/[^\r\n]/g, " "));
}
