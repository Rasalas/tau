import { ensureSyntaxTree, foldable } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { editorLanguageFor } from "./languages.js";

describe("editorLanguageFor", () => {
  it.each([
    ["src/app.ts", "TypeScript"], ["src/App.tsx", "TSX"], ["index.js", "JavaScript"], ["lib/x.mjs", "JavaScript"],
    ["view.jsx", "JSX"], ["package.json", "JSON"], ["tsconfig.jsonc", "JSON"], ["styles.css", "CSS"],
    ["index.html", "HTML"], ["README.md", "Markdown"], ["docs/NOTES.MD", "Markdown"], ["main.py", "Python"],
    ["src/lib.rs", "Rust"], ["cmd/main.go", "Go"], [".github/ci.yml", "YAML"], ["compose.yaml", "YAML"],
    ["scripts/build.sh", "Shell"], [".zshrc", "Shell"], ["Cargo.toml", "TOML"],
  ])("picks a mode for %s", (path, name) => {
    expect(editorLanguageFor(path)?.name).toBe(name);
  });

  it("leaves unknown files as plain text", () => {
    expect(editorLanguageFor("LICENSE")).toBeUndefined();
    expect(editorLanguageFor("data.bin")).toBeUndefined();
  });

  it("loads a mode only when asked, and it folds and parses", async () => {
    const typescript = editorLanguageFor("a.ts")!;
    expect(typescript.support).toBeUndefined();
    const support = await typescript.load();
    const state = EditorState.create({ doc: "function f() {\n  return 1;\n}\n", extensions: [support] });
    ensureSyntaxTree(state, state.doc.length, 5_000);
    expect(foldable(state, 0, state.doc.line(1).to)).toEqual({ from: 14, to: 27 });
  });

  it("loads every mode", async () => {
    for (const path of ["a.json", "a.css", "a.html", "a.md", "a.py", "a.rs", "a.go", "a.yml", "a.sh", "a.toml", "a.tsx"]) {
      expect((await editorLanguageFor(path)!.load()).language.name).toBeTruthy();
    }
  });
});
