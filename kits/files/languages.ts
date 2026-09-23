import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";

const legacy = (parser: StreamParser<unknown>) => new LanguageSupport(StreamLanguage.define(parser));

/**
 * The editor's language modes, each loaded the first time a file needs it.
 * Markdown reads the same list for its fenced code blocks.
 */
export const EDITOR_LANGUAGES: readonly LanguageDescription[] = [
  LanguageDescription.of({
    name: "TypeScript", alias: ["ts"], extensions: ["ts", "mts", "cts"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  }),
  LanguageDescription.of({
    name: "TSX", extensions: ["tsx"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true })),
  }),
  LanguageDescription.of({
    name: "JavaScript", alias: ["js", "node"], extensions: ["js", "mjs", "cjs"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  }),
  LanguageDescription.of({
    name: "JSX", extensions: ["jsx"],
    load: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: "JSON", alias: ["jsonc", "json5"], extensions: ["json", "jsonc", "json5", "webmanifest"], filename: /^\.(babelrc|eslintrc|prettierrc)$/u,
    load: () => import("@codemirror/lang-json").then((m) => m.json()),
  }),
  LanguageDescription.of({
    name: "CSS", extensions: ["css"],
    load: () => import("@codemirror/lang-css").then((m) => m.css()),
  }),
  LanguageDescription.of({
    name: "HTML", alias: ["xhtml"], extensions: ["html", "htm", "xhtml"],
    load: () => import("@codemirror/lang-html").then((m) => m.html()),
  }),
  LanguageDescription.of({
    name: "Markdown", alias: ["md"], extensions: ["md", "markdown", "mdx"],
    load: () => import("@codemirror/lang-markdown").then((m) => m.markdown({ codeLanguages: EDITOR_LANGUAGES })),
  }),
  LanguageDescription.of({
    name: "Python", alias: ["py"], extensions: ["py", "pyi", "pyw"],
    load: () => import("@codemirror/lang-python").then((m) => m.python()),
  }),
  LanguageDescription.of({
    name: "Rust", alias: ["rs"], extensions: ["rs"],
    load: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  }),
  LanguageDescription.of({
    name: "Go", alias: ["golang"], extensions: ["go"],
    load: () => import("@codemirror/lang-go").then((m) => m.go()),
  }),
  LanguageDescription.of({
    name: "YAML", alias: ["yml"], extensions: ["yaml", "yml"],
    load: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  }),
  LanguageDescription.of({
    name: "Shell", alias: ["sh", "bash", "zsh", "shell", "console"], extensions: ["sh", "bash", "zsh", "ksh"],
    filename: /^\.(bashrc|bash_profile|bash_aliases|zshrc|zshenv|zprofile|profile)$/u,
    load: () => import("@codemirror/legacy-modes/mode/shell").then((m) => legacy(m.shell)),
  }),
  LanguageDescription.of({
    name: "TOML", extensions: ["toml"],
    load: () => import("@codemirror/legacy-modes/mode/toml").then((m) => legacy(m.toml)),
  }),
];

/** The mode for a workspace path, by its file name; undefined for plain text. */
export function editorLanguageFor(path: string): LanguageDescription | undefined {
  const name = (path.split("/").filter(Boolean).at(-1) ?? path).toLowerCase();
  return LanguageDescription.matchFilename(EDITOR_LANGUAGES, name) ?? undefined;
}
