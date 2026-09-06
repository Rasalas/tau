/**
 * The bare specifiers an extension bundle may import: each one resolves to the
 * copy the renderer already runs, published on `globalThis.__tauShared`. Both
 * bundlers read this list — the runtime one through the renderer's
 * `SHARED_MODULES`, the prebuild through `scripts/build-kits.mjs` — so a
 * prebuilt kit binds exactly what a compiled-on-the-fly one does.
 */
export const SHARED_MODULE_SPECIFIERS = ["react", "react-dom", "react/jsx-runtime", "lucide-react", "tau"] as const;

export type SharedModuleSpecifier = (typeof SHARED_MODULE_SPECIFIERS)[number];

/** The npm packages among them; `tau` is the renderer's own API module. */
export const SHARED_MODULE_PACKAGES = SHARED_MODULE_SPECIFIERS.filter((name) => name !== "tau");

/**
 * Loaded on demand rather than with the workbench: the icon set is a chunk of
 * its own, fetched the first time a package needs it.
 */
export const DEFERRED_SHARED_MODULES: readonly SharedModuleSpecifier[] = ["lucide-react"];
