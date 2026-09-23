/**
 * Stands in for `@ungap/structured-clone` in the renderer build (see
 * `vite.renderer-build.ts`). Markdown's HAST conversion calls it without options,
 * which the package forwards to the native function every target has.
 */
export default function clone<T>(value: T): T {
  return structuredClone(value);
}
