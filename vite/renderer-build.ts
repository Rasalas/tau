/** What the desktop and browser builds of the renderer share. */
export const rendererBuild = {
  // These surfaces are loaded together on compact clients. One lazy chunk avoids
  // repeating their imports and keeps message sheets out of the desktop entry.
  output: {
    onlyExplicitManualChunks: true,
    manualChunks(id: string) {
      return /\/renderer\/touch\/(?!Sheet\.tsx$).*\.tsx$/u.test(id) ? "touch-surfaces" : undefined;
    },
  },
  // The oldest engines the renderer already needs (`structuredClone`, `Array.prototype.at`).
  // Vite's default lowers every class field to a helper call, 18 KB of the initial script.
  target: ["es2022", "chrome98", "edge98", "firefox94", "safari15.4"],
  // Vite's default, which `target` would otherwise change for the stylesheet too.
  cssTarget: ["es2020", "edge88", "firefox78", "chrome87", "safari14"],
};
