/** What the desktop and browser builds of the renderer share. */
export const rendererBuild = {
  output: {
    onlyExplicitManualChunks: true,
    manualChunks(id: string) {
      // Every first highlight needs the core and a grammar. Keep their common
      // grammar code in one lazy chunk, with registration still per language.
      if (/\/node_modules\/highlight\.js\//u.test(id) || id.endsWith("/renderer/components/highlight-typescript.ts")) return "syntax-highlighting";
      // Controls and row layout already import each other. Keep the shared
      // Settings primitives together, without pulling in any Settings page.
      if (/\/renderer\/settings\/(?:controls\.tsx|settings-layout\.tsx)$/u.test(id)) return "settings-controls";
      // These dialogs share their focus and closing behavior.
      if (/\/renderer\/components\/ui\/(?:Dialog|ConfirmDialog)\.tsx$/u.test(id)) return "dialogs";
      // These surfaces are loaded together on compact clients. One lazy chunk
      // avoids repeated imports and keeps message sheets out of the entry.
      return /\/renderer\/touch\/(?!Sheet\.tsx$).*\.tsx$/u.test(id) ? "touch-surfaces" : undefined;
    },
  },
  // The oldest engines the renderer already needs (`structuredClone`, `Array.prototype.at`).
  // Vite's default lowers every class field to a helper call, 18 KB of the initial script.
  target: ["es2022", "chrome98", "edge98", "firefox94", "safari15.4"],
  // Vite's default, which `target` would otherwise change for the stylesheet too.
  cssTarget: ["es2020", "edge88", "firefox78", "chrome87", "safari14"],
};
