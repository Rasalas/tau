import { fileURLToPath } from "node:url";

/** What the desktop and browser builds of the renderer share. */
export const rendererBuild = {
  resolve: {
    // Markdown's HAST step calls it without options, which the package forwards to the native function.
    alias: { "@ungap/structured-clone": fileURLToPath(new URL("src/renderer/components/structured-clone.ts", import.meta.url)) },
  },
  // The oldest engines the renderer already needs (`structuredClone`, `Array.prototype.at`).
  // Vite's default lowers every class field to a helper call, 18 KB of the initial script.
  target: ["es2022", "chrome98", "edge98", "firefox94", "safari15.4"],
  // Vite's default, which `target` would otherwise change for the stylesheet too.
  cssTarget: ["es2020", "edge88", "firefox78", "chrome87", "safari14"],
};
